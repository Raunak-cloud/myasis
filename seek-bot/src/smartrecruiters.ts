import { createHash } from 'node:crypto';
import type { JobListing } from './types.js';
import { listingAgeCutoff } from './listing-age.js';

const SMARTRECRUITERS_DEFAULT_COMPANIES = 'Canva,KPMGAustralia1,Colliers';
export const SMARTRECRUITERS_PAGE_SIZE = 50;

/** Employer identifiers, never URLs; all API requests use the fixed public host. */
export function smartRecruitersCompanies(raw: string): string[] {
  const companies = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
  if (!companies.length || companies.length > 20 || companies.some(value => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(value))) {
    throw new Error('Choose 1–20 SmartRecruiters employer identifiers, separated by commas (for example Canva,KPMGAustralia1,Colliers).');
  }
  return companies;
}

const postingId = /^(?:\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function smartRecruitersIdentity(raw: string): { company: string; posting: string } {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'jobs.smartrecruiters.com' || url.username || url.password || url.port) {
    throw new Error('The SmartRecruiters listing must be on its public jobs website.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const company = parts[0] ?? '';
  const posting = parts[1]?.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,20})(?:-|$)/i)?.[1] ?? '';
  smartRecruitersCompanies(company);
  if (!postingId.test(posting) || parts.length !== 2) throw new Error('Invalid SmartRecruiters job address.');
  return { company, posting };
}

const keyOf = (company: string, posting: string) =>
  `smartrecruiters-${createHash('sha256').update(`${company}:${posting}`).digest('hex').slice(0, 32)}`;

/** API HTML is converted to plain text before it reaches matching or prompts. */
function plainText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_, decimal, hex, name) => {
      if (name) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[name.toLowerCase()];
      const code = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, 50_000);
}

export function smartRecruitersListing(raw: unknown, company: string, now = Date.now()): JobListing | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, any>;
  const posting = String(data.id ?? '');
  if (!postingId.test(posting) || typeof data.name !== 'string' || !data.name.trim()
    || data.location?.country?.toLowerCase() !== 'au' || data.active === false
    || (data.visibility !== undefined && data.visibility !== 'PUBLIC')
    || (data.company?.identifier && data.company.identifier !== company)) return null;
  const canonical = `https://jobs.smartrecruiters.com/${company}/${posting}`;
  // Do not trust ref/applyUrl to send either the server or browser elsewhere.
  const safeUrl = (value: unknown) => {
    if (typeof value !== 'string' || !value) return canonical;
    const identity = smartRecruitersIdentity(value);
    if (identity.company !== company || identity.posting !== posting) throw new Error('SmartRecruiters returned a different job address.');
    return value;
  };
  const description = Object.values(data.jobAd?.sections ?? {})
    .map((section: any) => plainText(section?.text)).filter(Boolean).join('\n\n').slice(0, 50_000);
  const released = Date.parse(data.releasedDate ?? '');
  const location = [data.location.city, data.location.region, 'Australia'].filter(Boolean).join(', ');
  return {
    id: keyOf(company, posting), title: data.name.trim().slice(0, 300),
    company: String(data.company?.name || company).slice(0, 300), location,
    // An absent flag does not establish an on-site requirement.
    ...(data.location.hybrid === true ? { workArrangement: 'hybrid' } : data.location.remote === true ? { workArrangement: 'remote' } : {}),
    ...(Number.isFinite(released) ? { listedAt: new Date(released).toISOString(), ageDays: Math.max(0, Math.floor((now - released) / 86400000)) } : {}),
    url: safeUrl(data.postingUrl), applicationUrl: safeUrl(data.applyUrl),
    applicationMode: 'external', platform: 'smartrecruiters', source: 'search',
    ...(description ? { description, teaser: description.slice(0, 1000) } : {}),
  };
}

export class SmartRecruitersDiscovery {
  private readonly companies: string[];
  private readyAt = 0;
  private readonly options: {
    fetch?: typeof fetch; warn?: (message: string) => void;
    gapMs?: number; timeoutMs?: number; maxAgeDays?: number;
  };

  constructor(raw = SMARTRECRUITERS_DEFAULT_COMPANIES, options: {
    fetch?: typeof fetch; warn?: (message: string) => void;
    gapMs?: number; timeoutMs?: number; maxAgeDays?: number;
  } = {}) {
    this.companies = smartRecruitersCompanies(raw);
    this.options = options;
  }

  private async request(company: string, suffix: string): Promise<any> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.readyAt = Date.now() + (this.options.gapMs ?? 250);
    const response = await (this.options.fetch ?? fetch)(`https://api.smartrecruiters.com/v1/companies/${company}/postings${suffix}`, {
      headers: { Accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SmartRecruiters returned HTTP ${response.status} for ${company}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SmartRecruiters returned an empty response.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1_000_000) { await reader.cancel(); throw new Error('SmartRecruiters response exceeded its size limit.'); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async search(keyword: string, page: number): Promise<JobListing[]> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid SmartRecruiters search batch.');
    const params = new URLSearchParams({ country: 'au', destination: 'PUBLIC', q: keyword.trim().slice(0, 150),
      limit: String(SMARTRECRUITERS_PAGE_SIZE), offset: String((page - 1) * SMARTRECRUITERS_PAGE_SIZE) });
    if (this.options.maxAgeDays !== undefined) params.set('releasedAfter', listingAgeCutoff(this.options.maxAgeDays));
    const jobs = new Map<string, JobListing>();
    let successful = 0;
    for (const company of this.companies) {
      try {
        const data = await this.request(company, `?${params}`);
        if (!Array.isArray(data.content)) throw new Error('SmartRecruiters returned an invalid posting list.');
        successful++;
        for (const item of data.content.slice(0, SMARTRECRUITERS_PAGE_SIZE)) {
          try {
            const job = smartRecruitersListing(item, company);
            if (job) jobs.set(job.id, job);
          } catch { this.options.warn?.(`SmartRecruiters ignored a malformed listing from ${company}.`); }
        }
      } catch (error) {
        this.options.warn?.(`SmartRecruiters employer ${company} could not be searched: ${(error as Error).message}`);
      }
    }
    if (!successful) throw new Error('None of the selected SmartRecruiters employers could be searched.');
    return [...jobs.values()];
  }

  async detail(stub: JobListing): Promise<JobListing> {
    const { company, posting } = smartRecruitersIdentity(stub.url);
    if (!this.companies.includes(company)) throw new Error('This employer is outside the SmartRecruiters watchlist.');
    const data = await this.request(company, `/${posting}`);
    const job = smartRecruitersListing(data, company);
    if (!job || data.active !== true || data.visibility !== 'PUBLIC' || String(data.id) !== posting || job.id !== stub.id || !job.description) {
      throw new Error('The SmartRecruiters job is closed, changed or missing its description.');
    }
    return { ...job, source: stub.source ?? 'search' };
  }
}
