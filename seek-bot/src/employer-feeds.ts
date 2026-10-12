import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { careerTarget, employerTargets, identifierTarget, EMPLOYER_SOURCES, type EmployerSourceId } from './employer-source-config.js';
import { smartRecruitersIdentity } from './smartrecruiters.js';
import type { JobListing } from './types.js';

type NewSource = Exclude<EmployerSourceId, 'smartrecruiters'>;
type FeedOptions = { fetch?: typeof fetch; warn?: (message: string) => void; timeoutMs?: number; gapMs?: number; now?: () => number };
export const EMPLOYER_FEED_PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const dates = (value: unknown, now: number) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? { listedAt: new Date(at).toISOString(), ageDays: Math.max(0, Math.floor((now - at) / 86400000)) } : {};
};
const expired = (value: unknown, now: number) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) < now;

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
  if (source === 'lever' && url.hostname === 'jobs.lever.co' && path.length >= 2 && path.length <= 3 && UUID.test(path[1]) && (!path[2] || path[2] === 'apply')) {
    employerTargets('lever', path[0]); return { namespace: path[0], posting: path[1] };
  }
  if (source === 'greenhouse' && ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname) && path.length === 3 && path[1] === 'jobs' && /^\d{1,20}$/.test(path[2])) {
    employerTargets('greenhouse', path[0]); return { namespace: path[0], posting: path[2] };
  }
  if (source === 'pageup' && url.hostname === 'careers.pageuppeople.com' && path.length >= 5 && path.length <= 6 && path[3] === 'job' && /^\d{1,20}$/.test(path[4])) {
    const site = careerTarget('pageup', `${url.origin}/${path.slice(0, 3).join('/')}`).url;
    return { namespace: site.href, posting: path[4] };
  }
  if (source === 'workday' && path.length >= 4 && path[2] === 'job' && path.every(part => /^[A-Za-z0-9_.%()-]+$/.test(part))) {
    const site = careerTarget('workday', `${url.origin}/${path.slice(0, 2).join('/')}`).url;
    return { namespace: site.href, posting: `/${path.slice(2).join('/')}` };
  }
  throw new Error(`Invalid ${source} job address.`);
}

class PublicReader {
  private readyAt = 0;
  constructor(private options: FeedOptions) {}
  async read(url: string, body?: object): Promise<string> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.readyAt = Date.now() + (this.options.gapMs ?? 250);
    const response = await (this.options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      headers: { Accept: 'application/json,text/html', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Public career site returned HTTP ${response.status}.`); }
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
  private readonly now: () => number;
  constructor(readonly source: NewSource, raw?: string, private options: FeedOptions = {}) {
    const spec = EMPLOYER_SOURCES.find(item => item.id === source)!;
    this.targets = employerTargets(source, raw ?? spec.defaults);
    this.reader = new PublicReader(options); this.now = options.now ?? Date.now;
  }

  private listing(target: string, raw: any): JobListing | null {
    if (!raw || typeof raw !== 'object') return null;
    let id: string, title: string, company: string, location: string, url: string, description = '', at: unknown, arrangement: string | undefined;
    if (this.source === 'lever') {
      if (!UUID.test(String(raw.id)) || (raw.country && String(raw.country).toLowerCase() !== 'au')) return null;
      const board = identifierTarget(target);
      id = raw.id; title = clean(raw.text, 300); company = board.name || board.identifier; location = clean(raw.categories?.location, 500);
      url = `https://jobs.lever.co/${board.identifier}/${id}`;
      if (raw.hostedUrl && employerJobIdentity('lever', raw.hostedUrl).namespace !== board.identifier) throw new Error('Different Lever employer.');
      description = [raw.descriptionPlain || feedText(raw.description), ...(Array.isArray(raw.lists) ? raw.lists.map((list: any) => `${clean(list.text)}\n${feedText(list.content)}`) : []), raw.additionalPlain || feedText(raw.additional)].filter(Boolean).join('\n\n').slice(0, 50_000);
      // The public postings contract does not promise a publication date. Never invent it.
      arrangement = ['remote', 'hybrid', 'on-site'].includes(raw.workplaceType) ? raw.workplaceType : undefined;
    } else if (this.source === 'greenhouse') {
      if (!/^\d{1,20}$/.test(String(raw.id)) || expired(raw.application_deadline, this.now())) return null;
      id = String(raw.id); title = clean(raw.title, 300); company = clean(raw.company_name, 300) || target;
      location = clean(raw.location?.name, 500); url = `https://job-boards.greenhouse.io/${target}/jobs/${id}`;
      description = feedText(raw.content); at = raw.first_published;
      // updated_at is an edit timestamp, not the date the vacancy was advertised.
    } else if (this.source === 'workday') {
      const site = careerTarget('workday', target); const path = clean(raw.externalPath, 1500);
      url = `${site.url.href}${path}`; const identity = employerJobIdentity('workday', url);
      if (identity.namespace !== site.url.href || !path.startsWith('/job/')) throw new Error('Different Workday career site.');
      id = identity.posting; title = clean(raw.title, 300); company = site.name || site.url.hostname.split('.')[0]; location = clean(raw.locationsText, 500);
    } else {
      const site = careerTarget('pageup', target); url = new URL(raw.url, site.url).href;
      const identity = employerJobIdentity('pageup', url);
      if (identity.namespace !== site.url.href || expired(raw.closes, this.now())) return null;
      id = identity.posting; title = clean(raw.title, 300); company = site.name || `PageUp employer ${site.url.pathname.split('/')[1]}`;
      location = clean(raw.location, 500); description = clean(raw.teaser, 1000);
    }
    if (!title || !location) return null;
    const namespace = this.source === 'pageup' || this.source === 'workday' ? careerTarget(this.source, target).url.href : this.source === 'lever' ? identifierTarget(target).identifier : target;
    return { id: key(this.source, namespace, id), title, company, location, url, applicationUrl: url,
      platform: this.source, applicationMode: 'external', source: 'search', ...dates(at, this.now()),
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
      if (this.source === 'greenhouse') {
        const data = await this.reader.json(`https://boards-api.greenhouse.io/v1/boards/${target}/jobs?content=true`);
        if (!Array.isArray(data.jobs)) throw new Error('Invalid Greenhouse board response.');
        return data.jobs.slice(0, 2000);
      }
      const jobs: any[] = [];
      const board = identifierTarget(target);
      for (let offset = 0; offset < 2000; offset += 100) {
        const query = new URLSearchParams({ mode: 'json', limit: '100', skip: String(offset) });
        for (const location of board.locations) query.append('location', location);
        const data = await this.reader.json(`https://api.lever.co/v0/postings/${board.identifier}?${query}`);
        if (!Array.isArray(data)) throw new Error('Invalid Lever board response.');
        jobs.push(...data.slice(0, 100)); if (data.length < 100) break;
      }
      return jobs;
    })());
    return this.boardCache.get(target)!;
  }

  async search(keyword: string, page: number): Promise<JobListing[]> {
    if (!Number.isInteger(page) || page < 1 || page > 5) throw new Error('Invalid employer-feed search page.');
    const jobs = new Map<string, JobListing>(); let successful = 0;
    for (const target of this.targets) {
      try {
        let rows: any[];
        if (this.source === 'lever' || this.source === 'greenhouse') {
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
            if (filter === null) { successful++; continue; }
            if (filter) {
              this.countryFilters.set(target, filter);
              data = await this.reader.json(endpoint, { ...request, appliedFacets: filter });
            }
          }
          if (!Array.isArray(data.jobPostings)) throw new Error('Invalid Workday career-site response.');
          rows = this.normalise(target, data.jobPostings.slice(0, 20));
        } else {
          const { url } = careerTarget('pageup', target);
          const search = new URL(`${url.href}/search/`);
          search.search = new URLSearchParams({ 'search-keyword': keyword.slice(0, 150), page: String(page), 'page-items': '20' }).toString();
          const { document } = parseHTML(await this.reader.read(search.href));
          if (!document.querySelector('#search-results-content')) throw new Error('PageUp search layout is not recognised; no jobs were assumed.');
          rows = [...document.querySelectorAll('#search-results-content a.job-link')].slice(0, 20).map(anchor => {
            const row = anchor.closest('tr');
            return { url: anchor.getAttribute('href'), title: anchor.textContent, location: row?.querySelector('.location')?.textContent,
              closes: row?.querySelector('.close-date time')?.getAttribute('datetime'), teaser: row?.nextElementSibling?.classList.contains('summary') ? row.nextElementSibling.textContent : '' };
          });
          rows = this.normalise(target, rows);
        }
        successful++; for (const job of rows as JobListing[]) jobs.set(job.id, job);
      } catch (error) { this.options.warn?.(`${this.source} employer ${target} could not be searched: ${(error as Error).message}`); }
    }
    if (!successful) throw new Error(`None of the selected ${this.source} employers could be searched.`);
    return [...jobs.values()];
  }

  async detail(stub: JobListing): Promise<JobListing> {
    const identity = employerJobIdentity(this.source, stub.url);
    const target = this.targets.find(value => (this.source === 'pageup' || this.source === 'workday' ? careerTarget(this.source, value).url.href : this.source === 'lever' ? identifierTarget(value).identifier : value) === identity.namespace);
    if (!target || key(this.source, identity.namespace, identity.posting) !== stub.id) throw new Error('The job is outside the employer watchlist or its identity changed.');
    let job: JobListing | null;
    if (this.source === 'lever') {
      const raw = await this.reader.json(`https://api.lever.co/v0/postings/${identifierTarget(target).identifier}/${identity.posting}`);
      job = this.listing(target, raw);
    } else if (this.source === 'greenhouse') {
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
      const content = document.querySelector('#job-content');
      const jobNo = clean(content?.querySelector('.job-externalJobNo')?.textContent);
      const closes = content?.querySelector('.close-date time')?.getAttribute('datetime');
      if (jobNo !== identity.posting || !content?.querySelector('a.apply-link') || expired(closes, this.now())) throw new Error('PageUp job is closed or its identity changed.');
      job = this.listing(target, { url: stub.url, title: content.querySelector('h2')?.textContent, location: content.querySelector('.location')?.textContent });
      if (job) job = { ...job, description: feedText(content.querySelector('#job-details')?.innerHTML), ...dates(content.querySelector('.open-date time')?.getAttribute('datetime'), this.now()) };
    }
    if (!job || job.id !== stub.id || !job.description) throw new Error('Employer job is closed, changed or missing its description.');
    return { ...job, source: stub.source ?? 'search' };
  }
}
