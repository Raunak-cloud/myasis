/** Retirement data only; no provider adapters. Old links and saved drafts must
 * not reactivate integrations removed from the supported-source registry. */
const platforms = new Set(['lever']);
const domains = ['lever.co', 'hub24management.wd105.myworkdayjobs.com', 'hub24.com.au'];
const companies = new Set(['hub24']);
export const RETIRED_SOURCE_SETTING_KEYS = ['LEVER_COMPANIES'];
export const RETIRED_SOURCE_MESSAGE = 'This job source is no longer available.';

export function retiredJobDestination(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    return domains.some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return false; }
}

export function retiredJobSource(job: { platform?: string; company?: string; url?: string; applicationUrl?: string }): boolean {
  const company = (job.company ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(?:limited|ltd)$/, '');
  return platforms.has(job.platform ?? '') || companies.has(company)
    || [job.url, job.applicationUrl].some(url => Boolean(url && retiredJobDestination(url)));
}
