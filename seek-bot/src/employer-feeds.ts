import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { careerTarget, employerTargets, EMPLOYER_SOURCES, type EmployerSourceId } from './employer-source-config.js';
import { smartRecruitersIdentity } from './smartrecruiters.js';
import type { JobListing } from './types.js';
import { parseAgeDays } from './listing-age.js';
import {workdayDirectoryTargets} from './workday-directory.js';
import {publicEmployerTarget,publicEmployerTargets} from './public-employer-directory.js';
import { assertExternalJobUrl } from './external-url.js';
import { brandedPageupIdentity, brandedPageupSearch, brandedPageupPosting } from './pageup-branded.js';
import { EmployerFeedHealth } from './employer-feed-health.js';

type NewSource = Exclude<EmployerSourceId, 'smartrecruiters'>;
type FeedOptions = { fetch?: typeof fetch; warn?: (message: string) => void; timeoutMs?: number; gapMs?: number; retryDelayMs?: number; now?: () => number; additionalTargets?:string[]; shouldStop?:()=>boolean;
  healthDirectory?: string; validatePublicUrl?: (url: string) => Promise<string> };
const key = (source: string, namespace: string, id: string) => `${source}-${createHash('sha256').update(`${namespace}:${id}`).digest('hex').slice(0, 32)}`;
const clean = (value: unknown, limit = 50_000): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';
export function feedText(value: unknown): string {
  let html = clean(value, 500_000);
  // Greenhouse encodes its HTML; decode before parsing elements, not after stripping tags.
  for (let i = 0; i < 2 && /&lt;|&#60;/.test(html); i++) html = parseHTML(`<main>${html}</main>`).document.querySelector('main')?.textContent ?? html;
  const { document } = parseHTML(`<main>${html}</main>`);
  document.querySelectorAll('script,style').forEach(node => node.remove());
  document.querySelectorAll('p,div,li,h1,h2,h3,br').forEach(node => node.appendChild(document.createTextNode('\n')));
  return clean(document.querySelector('main')?.textContent?.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n'));
}
const dateValue = (value: unknown) => typeof value === 'string' ? /^\/Date\((-?\d+)\)\/$/.test(value) ? Number(value.slice(6,-2)) : Date.parse(value) : NaN;
const dates = (value: unknown, now: number) => {
  const at = dateValue(value);
  return Number.isFinite(at) ? { listedAt: new Date(at).toISOString(), ageDays: Math.max(0, Math.floor((now - at) / 86400000)) } : {};
};
const expired = (value: unknown, now: number) => Number.isFinite(dateValue(value)) && dateValue(value) < now;

/** Workday publishes each employer's facet parameter and opaque option IDs. */
export function workdayCountryFilter(facets: unknown, country = 'Australia'): Record<string, string[]> | null | undefined {
  if (!Array.isArray(facets)) return undefined;
  for (const facet of facets) {
    if (!facet || !Array.isArray(facet.values)) continue;
    if (typeof facet.facetParameter === 'string' && String(facet.descriptor).trim().toLowerCase() === 'country') {
      const value = facet.values.find((item: any) => typeof item?.descriptor === 'string' && item.descriptor.trim().toLowerCase() === country.toLowerCase());
      if (!value) return null; // The provider's current query has no postings in this country.
      if (typeof value.id !== 'string' || !value.id || value.id.length > 200 || facet.facetParameter.length > 200) return undefined;
      return { [facet.facetParameter]: [value.id] };
    }
    const nested = workdayCountryFilter(facet.values, country);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

/** Identity comes from a provider-owned URL; content cannot choose a network destination. */
export function employerJobIdentity(source: EmployerSourceId, raw: string): { namespace: string; posting: string } {
  if (source === 'smartrecruiters') { const id = smartRecruitersIdentity(raw); return { namespace: id.company, posting: id.posting }; }
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Use a public employer job URL.');
  const path = url.pathname.split('/').filter(Boolean);
  if (source === 'greenhouse' && ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname) && path.length === 3 && path[1] === 'jobs' && /^\d{1,20}$/.test(path[2])) {
    employerTargets('greenhouse', path[0]); return { namespace: path[0], posting: path[2] };
  }
  if (source === 'pageup' && url.hostname === 'careers.pageuppeople.com' && path.length >= 5 && path.length <= 6 && path[3] === 'job' && /^\d{1,20}$/.test(path[4])) {
    const site = careerTarget('pageup', `${url.origin}/${path.slice(0, 3).join('/')}`).url;
    return { namespace: site.href, posting: path[4] };
  }
  if (source === 'pageup') { const identity = brandedPageupIdentity(raw); if (identity) return identity; }
  if (source === 'workday' && path.length >= 4 && path[2] === 'job' && path.every(part => /^[A-Za-z0-9_.%()-]+$/.test(part))) {
    const site = careerTarget('workday', `${url.origin}/${path.slice(0, 2).join('/')}`).url;
    return { namespace: site.href, posting: `/${path.slice(2).join('/')}` };
  }
  throw new Error(`Invalid ${source} job address.`);
}

class CareerSiteHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Public career site returned HTTP ${status}.`); }
}
class PageUpCareerRedirect extends Error {
  constructor(readonly destination: string) { super('PageUp career site moved to its branded public careers page.'); }
}

function pageupBrand(document: ReturnType<typeof parseHTML>['document']):string {
  const title=document.title.match(/^(?:(?:Current|Career)\s+)?(?:opportunities|careers|jobs|vacancies|search results)\s*[-|–]\s*(.+)$/i)?.[1]?.trim();
  const logo=document.querySelector('header img[alt],#header img[alt],.logo img[alt],a.logo img[alt],img[id*="logo"][alt],img[src*="logo"][alt]')?.getAttribute('alt')?.trim();
  const name=title&&!/^(search results?|job search|listing|pageup(?:people)?)$/i.test(title)?title:logo;
  return name&&name.length<=100&&!/^(logo|home|pageup(?:people)?|email|facebook|twitter|linkedin)$/i.test(name)?name.replace(/\s+logo$/i,''):'';
}

class PublicReader {
  private readyAt = 0;
  constructor(private options: FeedOptions) {}
  async read(url: string, body?: object): Promise<string> {
    // These endpoints only read public career data (including Workday's
    // search POST). Retry transient transport/server failures once. Access
    // denials, rate limits, redirects and invalid data are never retried.
    for (let attempt = 0; ; attempt++) {
      try { return await this.readOnce(url, body); }
      catch (error) {
        const redirectRefused = error instanceof TypeError && error.cause instanceof Error && /redirect/i.test(error.cause.message);
        const transient = error instanceof CareerSiteHttpError ? error.status >= 500 && error.status <= 599
          : error instanceof Error && (['TimeoutError', 'AbortError'].includes(error.name)
            || (error instanceof TypeError && !redirectRefused && /fetch failed|network|terminated/i.test(error.message)));
        if (attempt || !transient || error instanceof CareerSiteHttpError && error.retryAfterMs > 0) throw error;
        await new Promise(resolve => setTimeout(resolve, this.options.retryDelayMs ?? 500));
      }
    }
  }
  private async readOnce(url: string, body?: object, redirects = 0): Promise<string> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.readyAt = Date.now() + (this.options.gapMs ?? 250);
    const pageupRoot = publicEmployerTarget('pageup', url);
    const response = await (this.options.fetch ?? fetch)(url, { redirect: pageupRoot ? 'manual' : 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      headers: { Accept: 'application/json,text/html', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (pageupRoot && [301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      const next = location ? new URL(location, url) : null;
      if (next && next.hostname !== 'careers.pageuppeople.com' && redirects < 2) throw new PageUpCareerRedirect(next.href);
      if (redirects >= 2 || !next || publicEmployerTarget('pageup', next.href) !== pageupRoot || !/\/(search|listing)\/?$/i.test(next.pathname)) throw Error('PageUp career-site redirect is outside this public results page.');
      // Some PageUp themes redirect search/ to listing/ and omit the filters.
      for (const [key,value] of new URL(url).searchParams) if(!next.searchParams.has(key))next.searchParams.set(key,value);
      return this.readOnce(next.href, undefined, redirects + 1);
    }
    return this.responseText(response);
  }
  private async responseText(response: Response): Promise<string> {
    if (/^(challenge|captcha|block)$/i.test(response.headers.get('x-amzn-waf-action') ?? '')) {
      await response.body?.cancel();throw Error('Public career site requires security verification.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const value = response.headers.get('retry-after'), seconds = Number(value);
      const delay = value ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - (this.options.now ?? Date.now)() : 0;
      throw new CareerSiteHttpError(response.status, Math.max(0, Number.isFinite(delay) ? delay : 0));
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty career-site response.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8_000_000) { await reader.cancel(); throw new Error('Career-site response exceeded its size limit.'); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async branded(url: string, origin: string, redirects = 0): Promise<{ url: string; html: string }> {
    const destination = new URL(url);
    if (destination.origin !== origin || !/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:jobs(?:\/[^/?#]+)?)?\/?$/.test(destination.pathname)) throw Error('Branded PageUp redirect left its public career pages.');
    await (this.options.validatePublicUrl ?? assertExternalJobUrl)(destination.href);
    const response = await (this.options.fetch ?? fetch)(destination.href, { redirect: 'manual', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000), headers: { Accept: 'text/html' } });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();const location=response.headers.get('location');
      if (!location || redirects >= 3) throw Error('Branded PageUp redirect limit reached.');
      return this.branded(new URL(location, destination).href, origin, redirects + 1);
    }
    return { url: destination.href, html: await this.responseText(response) };
  }
  async json(url: string, body?: object): Promise<any> { return JSON.parse(await this.read(url, body)); }
}

export class EmployerFeedDiscovery {
  private readonly targets: string[];
  private readonly reader: PublicReader;
  private readonly boardCache = new Map<string, Promise<any[]>>();
  private readonly countryFilters = new Map<string, Record<string, string[]>>();
  private readonly employerNames = new Map<string,string>();
  private readonly brandedSearches = new Map<string, string>();
  private readonly exhausted = new Map<string, number>();
  private readonly pageSignatures = new Map<string, string>();
  private readonly pageupSnapshots = new Map<string, Promise<JobListing[]>>();
  private readonly health: EmployerFeedHealth;
  private readonly now: () => number;
  constructor(readonly source: NewSource, raw?: string, private options: FeedOptions = {}) {
    const spec = EMPLOYER_SOURCES.find(item => item.id === source)!;
    if (!spec) throw new Error('This job source is no longer available.');
    this.targets = employerTargets(source, raw ?? spec.defaults);
    if(source==='workday') this.targets = workdayDirectoryTargets([...this.targets,...(options.additionalTargets??[])]);
    if(source==='pageup') this.targets = publicEmployerTargets('pageup',[...this.targets,...(options.additionalTargets??[])]);
    this.reader = new PublicReader(options); this.now = options.now ?? Date.now;
    this.health = new EmployerFeedHealth(options.healthDirectory, this.now);
  }

  private healthKey(target: string): string {
    const url = careerTarget(this.source as 'pageup' | 'workday', target).url;
    return this.source + ':' + (this.source === 'workday' ? `${url.origin}/wday/cxs/${url.hostname.split('.')[0]}/${url.pathname.split('/')[2]}/jobs` : url.href);
  }

  private pageupSnapshot(target: string): Promise<JobListing[]> {
    if (!this.pageupSnapshots.has(target)) {
      const task = (async () => {
        const root = careerTarget('pageup', target).url.href;
        const data = await this.reader.json(root + '/jobs.json');
        if (!Array.isArray(data)) throw Error('PageUp complete job feed is not a JSON array.');
        return this.normalise(target, data.filter(raw=>raw&&typeof raw==='object').map(raw => ({ url: root + '/job/' + String(raw.Id), title: raw.Title,
          location: raw.Locations || (Array.isArray(raw.LocationList) ? raw.LocationList.join('; ') : ''),
          overview: raw.Overview, teaser: raw.Summary, published: raw.OpeningDateUtc, closes: raw.ClosingDateUtc })));
      })();
      this.pageupSnapshots.set(target, task);void task.catch(() => this.pageupSnapshots.delete(target));
    }
    return this.pageupSnapshots.get(target)!;
  }

  private async brandedSearch(target: string, keyword: string, page: number, movedTo?: string): Promise<JobListing[]> {
    let search = this.brandedSearches.get(target);
    let result: {url:string;html:string} | undefined;
    if (!search) {
      if (!movedTo) throw Error('PageUp branded career site has not been verified.');
      const destination = new URL(movedTo);
      // Clinch's public search lives at /jobs/search. A provider redirect to
      // the home page must not make us parse that home page as job results.
      if (destination.pathname === '/') destination.pathname = '/jobs/search';
      destination.searchParams.set('query',keyword);destination.searchParams.set('page',String(page));
      result = await this.reader.branded(destination.href, destination.origin);
      search = brandedPageupSearch(result.html, result.url).action;
      this.brandedSearches.set(target, search);
    }
    const url = new URL(search);url.searchParams.set('query', keyword);url.searchParams.set('page', String(page));
    if (!result || result.url !== url.href) result = await this.reader.branded(url.href, url.origin);
    const parsed = brandedPageupSearch(result.html, result.url);
    if (parsed.exhausted || !parsed.returnedCards) this.exhausted.set(target + '\n' + keyword, page + 1);
    const configured = careerTarget('pageup', target);
    return parsed.jobs.map(raw => {
      const identity = employerJobIdentity('pageup', raw.url);
      return { id: key('pageup', identity.namespace, identity.posting), ...raw,
        company: configured.name || `PageUp employer ${configured.url.pathname.split('/')[1]}`,
        sourceCareerSite: configured.url.href, platform: 'pageup', applicationMode: 'external', source: 'search', applicationUrl: raw.url };
    });
  }

  private listing(target: string, raw: any): JobListing | null {
    if (!raw || typeof raw !== 'object') return null;
    let id: string, title: string, company: string, location: string, url: string, description = '', at: unknown, arrangement: string | undefined;
    if (this.source === 'greenhouse') {
      if (!/^\d{1,20}$/.test(String(raw.id)) || expired(raw.application_deadline, this.now())) return null;
      id = String(raw.id); title = clean(raw.title, 300); company = clean(raw.company_name, 300) || target;
      location = clean(raw.location?.name, 500); url = `https://job-boards.greenhouse.io/${target}/jobs/${id}`;
      description = feedText(raw.content); at = raw.first_published;
      // updated_at is an edit timestamp, not the date the vacancy was advertised.
    } else if (this.source === 'workday') {
      const site = careerTarget('workday', target); const path = clean(raw.externalPath, 1500);
      url = `${site.url.href}${path}`; const identity = employerJobIdentity('workday', url);
      if (identity.namespace !== site.url.href || !path.startsWith('/job/')) throw new Error('Different Workday career site.');
      id = identity.posting; title = clean(raw.title, 300); company = site.name || site.url.hostname.split('.')[0];
      // Some employers omit locationsText and supply configurable bullet fields.
      // Keep the card eligible for its authoritative detail read without guessing.
      location = clean(raw.locationsText, 500) || 'Location not disclosed';
    } else {
      const site = careerTarget('pageup', target); url = new URL(raw.url, site.url).href;
      const identity = employerJobIdentity('pageup', url);
      if (identity.namespace !== site.url.href || expired(raw.closes, this.now())) return null;
      id = identity.posting; title = clean(raw.title, 300); company = site.name || this.employerNames.get(target) || `PageUp employer ${site.url.pathname.split('/')[1]}`;
      location = clean(raw.location, 500); description = raw.overview ? feedText(raw.overview) : clean(raw.teaser, 1000); at = raw.published;
    }
    if (!title || !location) return null;
    const namespace = this.source === 'pageup' || this.source === 'workday' ? careerTarget(this.source, target).url.href : target;
    return { id: key(this.source, namespace, id), title, company, location, url, applicationUrl: url,
      ...(this.source==='workday' && typeof raw.country?.descriptor==='string' ? {locationCountry:clean(raw.country.descriptor,100)} : {}),
      ...(this.source==='workday' && Array.isArray(raw.bulletFields) ? {teaser:raw.bulletFields.filter((s:unknown)=>typeof s==='string').join(' · ').slice(0,1000)} : {}),
      platform: this.source, applicationMode: 'external', source: 'search', ...dates(at, this.now()),
      ...(this.source === 'workday' && parseAgeDays(raw.postedOn) !== undefined ? { ageDays: parseAgeDays(raw.postedOn), listedAt: clean(raw.postedOn) } : {}),
      ...(description ? { description, teaser: description.slice(0, 1000) } : {}), ...(arrangement ? { workArrangement: arrangement } : {}),
    };
  }

  private normalise(target: string, rows: any[]): JobListing[] {
    let malformed = 0;
    const jobs = rows.flatMap(raw => {
      try { const job = this.listing(target, raw); return job ? [job] : []; }
      catch { malformed++; return []; }
    });
    if (malformed) this.options.warn?.(`${this.source} ignored ${malformed} malformed listing(s) from ${target}.`);
    return jobs;
  }

  private async board(target: string): Promise<any[]> {
    if (!this.boardCache.has(target)) this.boardCache.set(target, (async () => {
      const data = await this.reader.json(`https://boards-api.greenhouse.io/v1/boards/${target}/jobs?content=true`);
      if (!Array.isArray(data.jobs)) throw new Error('Invalid Greenhouse board response.');
      return data.jobs;
    })());
    return this.boardCache.get(target)!;
  }

  async search(keyword: string, page: number): Promise<JobListing[]> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid employer-feed search batch.');
    const jobs = new Map<string, JobListing>(); let successful = 0;
    for (const target of this.targets) {
      if(this.options.shouldStop?.())break;
      const queryKey = target + '\n' + keyword;
      if (this.source !== 'greenhouse') {
        if (page >= (this.exhausted.get(queryKey) ?? Infinity)) { successful++; continue; }
        if (await this.health.unavailable(this.healthKey(target))) continue;
      }
      try {
        let rows: any[];
        if (this.source === 'greenhouse') {
          // A board is a bounded snapshot, not a keyword result page. Artificial
          // paging let adaptive discovery stop before later vacancies were even
          // ranked. Give AI the whole snapshot once; normal review/apply limits
          // still govern what it does with it. No relevance filter belongs here.
          rows = page === 1 ? this.normalise(target, await this.board(target)) : [];
        } else if (this.source === 'workday') {
          const { url } = careerTarget('workday', target); const site = url.pathname.split('/')[2]; const tenant = url.hostname.split('.')[0];
          const endpoint = `${url.origin}/wday/cxs/${tenant}/${site}/jobs`;
          const request = { limit: 20, offset: (page - 1) * 20, searchText: keyword.slice(0, 150), appliedFacets: this.countryFilters.get(target) ?? {} };
          let data = await this.reader.json(endpoint, request);
          if (!this.countryFilters.has(target)) {
            const filter = workdayCountryFilter(data.facets);
            if (filter === null) { this.exhausted.set(queryKey, page + 1); successful++; continue; }
            if (filter) {
              this.countryFilters.set(target, filter);
              data = await this.reader.json(endpoint, { ...request, appliedFacets: filter });
            }
          }
          if (!Array.isArray(data.jobPostings)) throw new Error('Invalid Workday career-site response.');
          rows = this.normalise(target, data.jobPostings.slice(0, 20));
          if (!data.jobPostings.length || Number.isSafeInteger(data.total) && request.offset + data.jobPostings.length >= data.total) this.exhausted.set(queryKey, page + 1);
        } else {
          if (this.brandedSearches.has(target)) {
            rows = await this.brandedSearch(target, keyword, page);
            successful++; for (const job of rows) jobs.set(job.id, job); await this.health.healthy(this.healthKey(target));continue;
          }
          const { url } = careerTarget('pageup', target);
          const search = new URL(`${url.href}/search/`);
          search.search = new URLSearchParams({ 'search-keyword': keyword.slice(0, 150), page: String(page), 'page-items': '20' }).toString();
          let html: string;
          try { html = await this.reader.read(search.href); }
          catch (error) {
            if (!(error instanceof PageUpCareerRedirect)) throw error;
            rows = await this.brandedSearch(target, keyword, page, error.destination);
            successful++; for (const job of rows) jobs.set(job.id, job); await this.health.healthy(this.healthKey(target));continue;
          }
          const { document } = parseHTML(html);
          // The background index's public reader may already have followed a verified redirect.
          const brandedForm = document.querySelector('form.job-search-results-form[action]')?.getAttribute('action');
          if (brandedForm && new URL(brandedForm, search).hostname !== url.hostname) {
            rows = await this.brandedSearch(target, keyword, page, new URL(brandedForm, search).href);
            successful++;for (const job of rows) jobs.set(job.id, job);await this.health.healthy(this.healthKey(target));continue;
          }
          if (!document.querySelector('#search-results-content')) throw new Error('PageUp search layout is not recognised; no jobs were assumed.');
          const brand=pageupBrand(document);if(brand)this.employerNames.set(target,brand);
          rows = [...document.querySelectorAll('#search-results-content a.job-link')].slice(0, 20).map(anchor => {
            const row = anchor.closest('tr,.job-listing');
            return { url: anchor.getAttribute('href'), title: anchor.textContent, location: row?.querySelector('.location')?.textContent,
              published: row?.querySelector('.open-date time')?.getAttribute('datetime'),
              closes: row?.querySelector('.close-date time')?.getAttribute('datetime'), teaser: row?.querySelector('.job-listing-left > p')?.textContent ?? (row?.nextElementSibling?.classList.contains('summary') ? row.nextElementSibling.textContent : '') };
          });
          const returnedCards = rows.length;
          rows = this.normalise(target, rows);
          if (!returnedCards) this.exhausted.set(queryKey, page + 1);
          const signature = rows.map(job => job.id).sort().join(',');
          if (signature && this.pageSignatures.get(queryKey) === signature) {
            // Some themes ignore page/filter parameters. Recover the publisher's
            // complete public feed rather than silently hiding later vacancies.
            rows = await this.pageupSnapshot(target);this.exhausted.set(queryKey, page + 1);
          }
          this.pageSignatures.set(queryKey, signature);
        }
        if (this.source !== 'greenhouse') await this.health.healthy(this.healthKey(target));
        successful++; for (const job of rows as JobListing[]) jobs.set(job.id, job);
      } catch (error) {
        if (this.source !== 'greenhouse') await this.health.failed(this.healthKey(target), (error as Error).message,
          error instanceof CareerSiteHttpError && error.retryAfterMs > 0 ? error.retryAfterMs : error instanceof CareerSiteHttpError && [404,410,422].includes(error.status) ? 3600_000 : 5 * 60_000);
        this.options.warn?.(`${this.source} employer ${target} could not be searched: ${(error as Error).message}`);
      }
    }
    if (!successful && !this.options.shouldStop?.()) throw new Error(`None of the selected ${this.source} employers could be searched.`);
    return [...jobs.values()];
  }

  async detail(stub: JobListing): Promise<JobListing> {
    const identity = employerJobIdentity(this.source, stub.url);
    if (this.source === 'pageup' && new URL(stub.url).hostname !== 'careers.pageuppeople.com') {
      const target = this.targets.find(value => careerTarget('pageup', value).url.href === stub.sourceCareerSite)
        ?? (!stub.sourceCareerSite && this.targets.length === 1 ? this.targets[0] : undefined);
      if (!target || key('pageup', identity.namespace, identity.posting) !== stub.id) throw Error('The branded job is outside its verified PageUp board.');
      if (!this.brandedSearches.has(target)) {
        try { await this.reader.read(careerTarget('pageup', target).url.href + '/search/'); }
        catch (error) { if (error instanceof PageUpCareerRedirect) await this.brandedSearch(target, '', 1, error.destination); else throw error; }
      }
      const verified = this.brandedSearches.get(target);
      if (!verified || new URL(verified).origin !== new URL(stub.url).origin) throw Error('PageUp job changed employer site.');
      const page = await this.reader.branded(stub.url, new URL(verified).origin), posting = brandedPageupPosting(page.html, page.url);
      if (employerJobIdentity('pageup', page.url).posting !== identity.posting || expired(posting.validThrough, this.now())) throw Error('Branded PageUp job is closed or changed.');
      const locations = [posting.jobLocation].flat().filter(Boolean).map(place => place.address ?? {}).map(address => [address.addressLocality,address.addressRegion,
        typeof address.addressCountry==='string'?address.addressCountry:address.addressCountry?.name].filter(Boolean).join(', ')).filter(Boolean);
      const name = careerTarget('pageup', target).name || clean(posting.hiringOrganization?.name, 300) || stub.company;
      return { ...stub, title: clean(posting.title,300), company: name, location: locations.join('; ') || stub.location,
        description: feedText(posting.description), ...dates(posting.datePosted, this.now()) };
    }
    const target = this.targets.find(value => (this.source === 'pageup' || this.source === 'workday' ? careerTarget(this.source, value).url.href : value) === identity.namespace);
    if (!target || key(this.source, identity.namespace, identity.posting) !== stub.id) throw new Error('The job is outside the employer watchlist or its identity changed.');
    let job: JobListing | null;
    if (this.source === 'greenhouse') {
      const raw = await this.reader.json(`https://boards-api.greenhouse.io/v1/boards/${target}/jobs/${identity.posting}?content=true`);
      job = this.listing(target, raw);
    } else if (this.source === 'workday') {
      const { url } = careerTarget('workday', target); const site = url.pathname.split('/')[2]; const tenant = url.hostname.split('.')[0];
      const raw = (await this.reader.json(`${url.origin}/wday/cxs/${tenant}/${site}${identity.posting}`)).jobPostingInfo;
      if (!raw || raw.country?.descriptor !== 'Australia' || expired(raw.endDate, this.now())) throw new Error('Workday job is closed or not in Australia.');
      job = this.listing(target, { ...raw, externalPath: identity.posting, locationsText: raw.location });
      if (job) job = { ...job, description: feedText(raw.jobDescription), ...dates(raw.startDate, this.now()), ...(raw.remoteType ? { workArrangement: clean(raw.remoteType) } : {}) };
    } else {
      const { document } = parseHTML(await this.reader.read(stub.url));
      const brand=pageupBrand(document);if(brand)this.employerNames.set(target,brand);
      const content = document.querySelector('#job-content');
      const jobNo = clean(content?.querySelector('.job-externalJobNo')?.textContent);
      const closes = content?.querySelector('.close-date time')?.getAttribute('datetime');
      const apply = content?.querySelector('a.apply-link') || [...(content?.querySelectorAll('a[href]')??[])].find(anchor=>{
        try{const u=new URL(anchor.getAttribute('href')!,stub.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^secure(?:\.dc\d+)?\.pageuppeople\.com$/.test(u.hostname)
          &&u.pathname===`/apply/${new URL(identity.namespace).pathname.split('/')[1]}/gateway/default.aspx`&&u.searchParams.get('c')==='apply'&&u.searchParams.get('lJobID')===identity.posting;}catch{return false;}
      });
      if (jobNo !== identity.posting || !apply || expired(closes, this.now())) throw new Error('PageUp job is closed or its identity changed.');
      job = this.listing(target, { url: stub.url, title: content!.querySelector('h1,h2')?.textContent, location: content!.querySelector('.location')?.textContent });
      if(job&&!careerTarget('pageup',target).name&&!this.employerNames.has(target)&&stub.company&&!/^PageUp employer \d+$/i.test(stub.company))job.company=stub.company;
      if (job) job = { ...job, description: feedText(content!.querySelector('#job-details,.section-job-overview')?.innerHTML), ...dates(content!.querySelector('.open-date time')?.getAttribute('datetime'), this.now()) };
    }
    if (!job || job.id !== stub.id || !job.description) throw new Error('Employer job is closed, changed or missing its description.');
    return { ...job, source: stub.source ?? 'search' };
  }
}
