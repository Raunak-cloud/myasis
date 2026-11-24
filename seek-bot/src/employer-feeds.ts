import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { workdayCareerTarget, employerTargets, EMPLOYER_SOURCES, type EmployerSourceId } from './employer-source-config.js';
import type { JobListing } from './types.js';
import { parseAgeDays } from './listing-age.js';
import {workdayDirectoryTargets} from './workday-directory.js';
import {publicEmployerTargets} from './public-employer-directory.js';
import { EmployerFeedHealth } from './employer-feed-health.js';
import { EmployerFeedPaging, type EmployerFeedBatch } from './employer-feed-paging.js';

type FeedOptions = { fetch?: typeof fetch; warn?: (message: string) => void; timeoutMs?: number; gapMs?: number; retryDelayMs?: number; now?: () => number; additionalTargets?:string[]; shouldStop?:()=>boolean;
  healthDirectory?: string };
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
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Use a public employer job URL.');
  const path = url.pathname.split('/').filter(Boolean);
  if (source === 'greenhouse' && ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname) && path.length === 3 && path[1] === 'jobs' && /^\d{1,20}$/.test(path[2])) {
    employerTargets('greenhouse', path[0]); return { namespace: path[0], posting: path[2] };
  }
  if (source === 'workday' && path.length >= 4 && path[2] === 'job' && path.every(part => /^[A-Za-z0-9_.%()-]+$/.test(part))) {
    const site = workdayCareerTarget(`${url.origin}/${path.slice(0, 2).join('/')}`).url;
    return { namespace: site.href, posting: `/${path.slice(2).join('/')}` };
  }
  throw new Error(`Invalid ${source} job address.`);
}

class CareerSiteHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Public career site returned HTTP ${status}.`); }
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
  private async readOnce(url: string, body?: object): Promise<string> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.readyAt = Date.now() + (this.options.gapMs ?? 250);
    const response = await (this.options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      headers: { Accept: 'application/json,text/html', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
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
  async json(url: string, body?: object): Promise<any> { return JSON.parse(await this.read(url, body)); }
}

export class EmployerFeedDiscovery {
  private readonly targets: string[];
  private readonly reader: PublicReader;
  private readonly boardCache = new Map<string, Promise<any[]>>();
  private readonly countryFilters = new Map<string, Record<string, string[]>>();
  private readonly paging = new EmployerFeedPaging();
  private readonly health: EmployerFeedHealth;
  private readonly now: () => number;
  constructor(readonly source: EmployerSourceId, raw?: string, private options: FeedOptions = {}) {
    const spec = EMPLOYER_SOURCES.find(item => item.id === source)!;
    if (!spec) throw new Error('This job source is no longer available.');
    this.targets = employerTargets(source, raw ?? spec.defaults);
    if(source==='workday') this.targets = workdayDirectoryTargets([...this.targets,...(options.additionalTargets??[])]);
    if (source === 'greenhouse') this.targets = publicEmployerTargets([...this.targets,...(options.additionalTargets??[])]);
    this.reader = new PublicReader(options); this.now = options.now ?? Date.now;
    this.health = new EmployerFeedHealth(options.healthDirectory, this.now);
  }

  private healthKey(target: string): string {
    const { url } = workdayCareerTarget(target);
    return `workday:${url.origin}/wday/cxs/${url.hostname.split('.')[0]}/${url.pathname.split('/')[2]}/jobs`;
  }

  private listing(target: string, raw: any): JobListing | null {
    if (!raw || typeof raw !== 'object') return null;
    let id: string, title: string, company: string, location: string, url: string, description = '', at: unknown;
    if (this.source === 'greenhouse') {
      if (!/^\d{1,20}$/.test(String(raw.id)) || expired(raw.application_deadline, this.now())) return null;
      id = String(raw.id); title = clean(raw.title, 300); company = clean(raw.company_name, 300) || target;
      location = clean(raw.location?.name, 500); url = `https://job-boards.greenhouse.io/${target}/jobs/${id}`;
      description = feedText(raw.content); at = raw.first_published;
      // updated_at is an edit timestamp, not the date the vacancy was advertised.
    } else {
      const site = workdayCareerTarget(target); const path = clean(raw.externalPath, 1500);
      url = `${site.url.href}${path}`; const identity = employerJobIdentity('workday', url);
      if (identity.namespace !== site.url.href || !path.startsWith('/job/')) throw new Error('Different Workday career site.');
      id = identity.posting; title = clean(raw.title, 300); company = site.name || site.url.hostname.split('.')[0];
      // Some employers omit locationsText and supply configurable bullet fields.
      // Keep the card eligible for its authoritative detail read without guessing.
      location = clean(raw.locationsText, 500) || 'Location not disclosed';
    }
    if (!title || !location) return null;
    const namespace = this.source === 'workday' ? workdayCareerTarget(target).url.href : target;
    return { id: key(this.source, namespace, id), title, company, location, url, applicationUrl: url,
      ...(this.source==='workday' && typeof raw.country?.descriptor==='string' ? {locationCountry:clean(raw.country.descriptor,100)} : {}),
      ...(this.source==='workday' && Array.isArray(raw.bulletFields) ? {teaser:raw.bulletFields.filter((s:unknown)=>typeof s==='string').join(' · ').slice(0,1000)} : {}),
      platform: this.source, applicationMode: 'external', source: 'search', ...dates(at, this.now()),
      ...(this.source === 'workday' && parseAgeDays(raw.postedOn) !== undefined ? { ageDays: parseAgeDays(raw.postedOn), listedAt: clean(raw.postedOn) } : {}),
      ...(description ? { description, teaser: description.slice(0, 1000) } : {}),
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
    return (await this.searchBatch(keyword, page)).jobs;
  }

  async searchBatch(keyword: string, page: number): Promise<EmployerFeedBatch> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid employer-feed search batch.');
    const jobs = new Map<string, JobListing>(); let successful = 0, hasMore = false;
    for (const target of this.targets) {
      if(this.options.shouldStop?.())break;
      const queryKey = target + '\n' + keyword;
      if (this.source !== 'greenhouse') {
        if (this.paging.exhausted(queryKey, page)) { successful++; continue; }
        if (await this.health.unavailable(this.healthKey(target))) continue;
      }
      try {
        let rows: JobListing[];
        if (this.source === 'greenhouse') {
          // A board is a bounded snapshot, not a keyword result page. Artificial
          // paging let adaptive discovery stop before later vacancies were even
          // ranked. Give AI the whole snapshot once; normal review/apply limits
          // still govern what it does with it. No relevance filter belongs here.
          rows = page === 1 ? this.normalise(target, await this.board(target)) : [];
        } else {
          const { url } = workdayCareerTarget(target); const site = url.pathname.split('/')[2]; const tenant = url.hostname.split('.')[0];
          const endpoint = `${url.origin}/wday/cxs/${tenant}/${site}/jobs`;
          const request = { limit: 20, offset: (page - 1) * 20, searchText: keyword.slice(0, 150), appliedFacets: this.countryFilters.get(target) ?? {} };
          let data = await this.reader.json(endpoint, request);
          if (!this.countryFilters.has(target)) {
            const filter = workdayCountryFilter(data.facets);
            if (filter === null) { this.paging.end(queryKey, page); successful++; continue; }
            if (filter) {
              this.countryFilters.set(target, filter);
              data = await this.reader.json(endpoint, { ...request, appliedFacets: filter });
            }
          }
          if (!Array.isArray(data.jobPostings)) throw new Error('Invalid Workday career-site response.');
          rows = this.normalise(target, data.jobPostings.slice(0, 20));
          if (!data.jobPostings.length || Number.isSafeInteger(data.total) && request.offset + data.jobPostings.length >= data.total
            || this.paging.repeated(queryKey, page, data.jobPostings.map((item: any) => item?.externalPath))) {
            this.paging.end(queryKey, page);
          }
        }
        if (this.source !== 'greenhouse') {
          hasMore ||= !this.paging.exhausted(queryKey, page + 1);
          await this.health.healthy(this.healthKey(target));
        }
        successful++; for (const job of rows) jobs.set(job.id, job);
      } catch (error) {
        if (this.source !== 'greenhouse') await this.health.failed(this.healthKey(target), (error as Error).message,
          error instanceof CareerSiteHttpError && error.retryAfterMs > 0 ? error.retryAfterMs : error instanceof CareerSiteHttpError && [404,410,422].includes(error.status) ? 3600_000 : 5 * 60_000);
        this.options.warn?.(`${this.source} employer ${target} could not be searched: ${(error as Error).message}`);
      }
    }
    if (!successful && !this.options.shouldStop?.()) throw new Error(`None of the selected ${this.source} employers could be searched.`);
    return { jobs: [...jobs.values()], hasMore };
  }

  async detail(stub: JobListing): Promise<JobListing> {
    const identity = employerJobIdentity(this.source, stub.url);
    const target = this.targets.find(value => (this.source === 'workday' ? workdayCareerTarget(value).url.href : value) === identity.namespace);
    if (!target || key(this.source, identity.namespace, identity.posting) !== stub.id) throw new Error('The job is outside the employer watchlist or its identity changed.');
    let job: JobListing | null;
    if (this.source === 'greenhouse') {
      const raw = await this.reader.json(`https://boards-api.greenhouse.io/v1/boards/${target}/jobs/${identity.posting}?content=true`);
      job = this.listing(target, raw);
    } else {
      const { url } = workdayCareerTarget(target); const site = url.pathname.split('/')[2]; const tenant = url.hostname.split('.')[0];
      const raw = (await this.reader.json(`${url.origin}/wday/cxs/${tenant}/${site}${identity.posting}`)).jobPostingInfo;
      if (!raw || raw.country?.descriptor !== 'Australia' || expired(raw.endDate, this.now())) throw new Error('Workday job is closed or not in Australia.');
      job = this.listing(target, { ...raw, externalPath: identity.posting, locationsText: raw.location });
      if (job) job = { ...job, description: feedText(raw.jobDescription), ...dates(raw.startDate, this.now()), ...(raw.remoteType ? { workArrangement: clean(raw.remoteType) } : {}) };
    }
    if (!job || job.id !== stub.id || !job.description) throw new Error('Employer job is closed, changed or missing its description.');
    return { ...job, source: stub.source ?? 'search' };
  }
}
