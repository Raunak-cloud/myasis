// PageUp and SmartRecruiters are retired as discovery feeds. Their employer
// forms remain valid destinations for jobs found through supported sources.
const employerFeeds = ['smartrecruiters', 'pageup'];
const employerFeedDomains = ['smartrecruiters.com', 'pageuppeople.com'];
const retiredDiscoveryPlatforms = new Set(['lever', 'web-search', ...employerFeeds]);
const blockedApplicationDomains = ['lever.co', 'hub24management.wd105.myworkdayjobs.com', 'hub24.com.au'];
export const RETIRED_SOURCE_SETTING_KEYS = ['LEVER_COMPANIES', 'SMARTRECRUITERS_COMPANIES', 'SMARTRECRUITERS_ADMIN_ENABLED', 'PAGEUP_SITES'];
export const RETIRED_SOURCE_MESSAGE = 'This job source is no longer available.';

function matchesDomain(raw: string, blocked: string[]): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    return blocked.some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return false; }
}

export function retiredJobDestination(raw: string): boolean {
  return matchesDomain(raw, blockedApplicationDomains);
}

export function retiredDiscoveryPlatform(platform: string): boolean {
  return retiredDiscoveryPlatforms.has(platform);
}

export function retiredEmployerFeed(job: { platform?: string; url?: string }): boolean {
  return employerFeeds.includes(job.platform ?? '') || Boolean(job.url && matchesDomain(job.url, employerFeedDomains));
}

export function retiredJobSource(job: { platform?: string; company?: string; url?: string; applicationUrl?: string }): boolean {
  const company = (job.company ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(?:limited|ltd)$/, '');
  return job.platform === 'lever' || company === 'hub24'
    || [job.url, job.applicationUrl].some(url => Boolean(url && retiredJobDestination(url)));
}
