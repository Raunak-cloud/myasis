import type { JobListing } from './types.js';
import type { DiscoverySearch } from './discovery-search.js';

const PAGE_SIZE = 50;
const text = (value: unknown, limit = 1000) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';

/** Only the API's Australian Adzuna tracking link may leave discovery. */
export function adzunaListing(raw: unknown, now = Date.now()): JobListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, any>;
  const id = String(data.id ?? '');
  const title = text(data.title, 300);
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  let url: URL;
  try { url = new URL(data.redirect_url); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !['www.adzuna.com.au', 'adzuna.com.au'].includes(url.hostname)
    || url.username || url.password || url.port || !new RegExp(`^/jobs/land/ad/${id}(?:/|$)`).test(url.pathname)) return null;
  url.protocol = 'https:';
  const created = Date.parse(data.created);
  const predicted = String(data.salary_is_predicted) !== '0';
  const salaryMin = Number(data.salary_min), salaryMax = Number(data.salary_max);
  const amounts = [salaryMin, salaryMax].filter(value => Number.isFinite(value) && value > 0);
  return {
    id: `adzuna-${id}`, platform: 'adzuna', source: 'search', title,
    company: text(data.company?.display_name, 300) || 'Unknown',
    location: text(data.location?.display_name, 1000), locationCountry: 'Australia',
    url: url.href, listingSourceUrl: url.href, applicationMode: 'unknown',
    teaser: text(data.description),
    // API descriptions are truncated. Read the actual vacancy before matching.
    ...(Number.isFinite(created) ? { listedAt: new Date(created).toISOString(), ageDays: Math.max(0, Math.floor((now - created) / 86400000)) } : {}),
    // Adzuna's estimates are not employer-disclosed pay or filtering evidence.
    ...(!predicted && amounts.length ? { salary: `AUD ${amounts.map(value => value.toLocaleString('en-AU')).join('–')} per year` } : {}),
  };
}

export class AdzunaDiscovery {
  private readonly cache = new Map<string, Promise<JobListing[]>>();
  private stopped = false;
  constructor(private readonly options: { appId: string; appKey: string; maxAgeDays?: number;
    fetch?: typeof fetch; timeoutMs?: number }) {
    if (!options.appId.trim() || !options.appKey.trim()) throw new Error('Adzuna is not configured.');
  }

  search(keyword: string, page: number, scope?: DiscoverySearch): Promise<JobListing[]> {
    if (!Number.isSafeInteger(page) || page < 1) return Promise.reject(new Error('Invalid Adzuna search page.'));
    // Work-arrangement labels do not change this API query. Reuse identical
    // requests rather than spending another quota call for the same results.
    const key = JSON.stringify([keyword.trim().slice(0,150), page, scope?.location || '', scope?.location ? scope.radiusKm : 0]);
    if (!this.cache.has(key)) this.cache.set(key, this.read(keyword, page, scope));
    return this.cache.get(key)!;
  }

  private async read(keyword: string, page: number, scope?: DiscoverySearch): Promise<JobListing[]> {
    if (this.stopped) throw new Error('Adzuna is unavailable for the rest of this run.');
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/au/search/${page}`);
    const params = url.searchParams;
    params.set('app_id', this.options.appId); params.set('app_key', this.options.appKey);
    params.set('results_per_page', String(PAGE_SIZE)); params.set('sort_by', 'date');
    params.set('what', keyword.trim().slice(0, 150)); params.set('content-type', 'application/json');
    if (scope?.location) {
      params.set('where', scope.location);
      if (scope.radiusKm > 0) params.set('distance', String(scope.radiusKm));
    }
    if (this.options.maxAgeDays !== undefined && Number.isFinite(this.options.maxAgeDays)) {
      params.set('max_days_old', String(Math.max(1, Math.ceil(this.options.maxAgeDays))));
    }
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url.href, {
        headers: { Accept: 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
      });
    } catch { throw new Error('Adzuna search could not be reached.'); } // Fetch errors can contain the secret query string.
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) this.stopped = true;
      await response.body?.cancel();
      throw new Error(`Adzuna search returned HTTP ${response.status}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Adzuna returned an empty response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); throw new Error(); }
        chunks.push(part.value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.results)) throw new Error();
      const jobs = new Map<string, JobListing>();
      for (const raw of data.results.slice(0, PAGE_SIZE)) {
        const job = adzunaListing(raw); if (job) jobs.set(job.id, job);
      }
      return [...jobs.values()];
    } catch { throw new Error('Adzuna returned an invalid or oversized job response.'); }
  }
}
