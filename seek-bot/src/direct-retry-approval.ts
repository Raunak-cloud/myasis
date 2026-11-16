import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { applicationUrlKey } from './application-identity.js';
import { currentFitReview, reviewContextFingerprint } from './review-cache.js';
import { employerJobIdentity, EmployerFeedDiscovery } from './employer-feeds.js';
import { isEmployerSource } from './employer-source-config.js';
import { SmartRecruitersDiscovery, smartRecruitersIdentity } from './smartrecruiters.js';
import type { CandidateProfile, JobListing } from './types.js';

const clean = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const sameUrl = (first: string | undefined, second: string | undefined) => Boolean(first && second && applicationUrlKey(first) && applicationUrlKey(first) === applicationUrlKey(second));

async function refreshEmployerJob(previous: JobListing): Promise<JobListing> {
  if (previous.platform === 'smartrecruiters') return new SmartRecruitersDiscovery(smartRecruitersIdentity(previous.url).company).detail(previous);
  if (!isEmployerSource(previous.platform ?? '')) throw Error('No trusted vacancy refresh is available for this source.');
  const source = previous.platform as 'greenhouse' | 'pageup' | 'workday';
  const target = previous.sourceCareerSite || employerJobIdentity(source, previous.url).namespace;
  return new EmployerFeedDiscovery(source, target).detail(previous);
}

/** Owner-local, provably unsent technical attempts only. Reuse the actual
 * matched listing, never relabel a bare URL as candidate approval. Full source
 * content and the existing candidate/context fingerprint must remain current. */
export async function priorDirectApproval(
  direct: JobListing, profile: CandidateProfile,
  refresh: (previous: JobListing) => Promise<JobListing> = refreshEmployerJob,
): Promise<JobListing | undefined> {
  const directory = resolve(config.dataDir, 'traces');
  let candidates: { path: string; size: number; modified: number }[];
  try {
    candidates = readdirSync(directory).filter(name => /^attempt-[a-f0-9-]{36}\.json$/i.test(name)).flatMap(name => {
      const path = resolve(directory, name), info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink() && info.size <= 8_000_000 ? [{ path, size: info.size, modified: info.mtimeMs }] : [];
    }).sort((a, b) => b.modified - a.modified).slice(0, 100);
  } catch { return undefined; }
  const context = reviewContextFingerprint(profile);
  let readBytes = 0;
  for (const file of candidates) {
    readBytes += file.size;
    if (readBytes > 64_000_000) break;
    try {
      const trace = JSON.parse(readFileSync(file.path, 'utf8'));
      const previous = trace.job as JobListing;
      if (trace.outcome?.status !== 'error' || trace.outcome.retryable !== true || trace.sendAudit?.attempted !== false
        || !Array.isArray(trace.steps) || trace.steps.some((step: { args?: { sends_application?: boolean; actions?: { sends_application?: boolean }[] } }) => step.args?.sends_application === true || step.args?.actions?.some(action => action.sends_application === true))
        || !previous?.fitReview || previous.fitReview.contextFingerprint !== context
        || !isEmployerSource(previous.platform ?? '')
        || ![previous.url, previous.applicationUrl].some(url => sameUrl(url, direct.url))
        || ![previous.url, previous.applicationUrl].some(url => sameUrl(url, direct.applicationUrl))
        || clean(previous.title) !== clean(direct.title) || clean(previous.company) !== clean(direct.company)) continue;
      const fresh = await refresh(previous);
      if (fresh.id !== previous.id || fresh.platform !== previous.platform || !sameUrl(fresh.url, previous.url)) continue;
      const matched = { ...fresh, source: previous.source, fitReview: previous.fitReview };
      if (currentFitReview(matched, profile)) return matched;
    } catch { /* An unreadable/stale attempt cannot supply approval. */ }
  }
  return undefined;
}
