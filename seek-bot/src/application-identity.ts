import type { AppliedRecord, JobListing } from './types.js';

/** Preserve vacancy, tenant and routing parameters; omit attribution and
 * SEEK's per-candidate/job/session handoff token from identity only. Keep the
 * original browser URL intact for the employer's application-complete signal.
 * https://developer.seek.com/use-cases/apply-with-seek/send-application-complete-signal */
export function applicationUrlKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hostname = url.hostname.replace(/^www\./, '');
    if (!/^#[/!]/.test(url.hash)) url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:fbclid|gclid|msclkid|seek-token)$/i.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

/** Some ATSs reuse /apply or /review for every vacancy. Such a URL identifies
 * a form template, not a vacancy: qualify it with listing context rather than
 * permanently blocking every other job at that employer. */
export function applicationFormKey(job: Pick<JobListing, 'company' | 'title' | 'location'>, raw: string): string | null {
  let canonical = applicationUrlKey(raw);
  if (!canonical) return null;
  const url = new URL(canonical);
  // Workday resumes a manually filled application at /apply. The optional
  // /applyManually entry step does not change its vacancy or approved content.
  // Preserve the career site, requisition path and every routing parameter;
  // never rewrite the original browser URL or normalize other providers.
  if (url.hostname.endsWith('.myworkdayjobs.com') && /\/job\/.+\/apply\/applyManually\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/applyManually\/?$/, '');
    canonical = url.href;
  }
  const postingPath = /\/(?:jobs?|vacanc(?:y|ies)|requisitions?|positions?)\/[^/]+/i.test(url.pathname)
    || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{18,}/i.test(url.pathname);
  const postingQuery = [...url.searchParams.keys()].some(key => /^(?:job|vacancy|requisition|position|posting)(?:id|_id|key)?$/i.test(key));
  if (postingPath || postingQuery) return `url:${canonical}`;
  const context = [job.company, job.title, job.location].map(value => value.trim().toLowerCase().replace(/\s+/g, ' '));
  return `form:${canonical}:${JSON.stringify(context)}`;
}

export function applicationKeys(job: Pick<JobListing, 'id' | 'platform' | 'url' | 'applicationUrl' | 'company' | 'title' | 'location'>): string[] {
  const keys = [`listing:${job.platform ?? 'seek'}:${job.id}`];
  const form = applicationFormKey(job, job.applicationUrl ?? job.url);
  if (form) keys.push(form);
  return keys;
}

/** A matching role on a different platform/form is explicitly allowed. */
export function sameApplication(record: AppliedRecord, job: JobListing): boolean {
  if (record.platform === (job.platform ?? 'seek') && record.jobId === job.id) return true;
  const known = applicationKeys(job);
  return [record.url, record.applicationUrl].some(raw => {
    const form = raw ? applicationFormKey(record, raw) : null;
    return form !== null && known.includes(form);
  });
}
