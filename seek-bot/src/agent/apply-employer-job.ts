import type { Page } from 'patchright';
import type { ApplyOutcome, CandidateProfile, JobListing } from '../types.js';
import type { ApplyDeps } from './apply-agent.js';
import { config } from '../config.js';
import { outsideScope, scopeSkipReason } from '../run-scope.js';
import { guardExternalNavigations } from '../external-url.js';
import { employerJobIdentity } from '../employer-feeds.js';
import { isEmployerSource, employerFeedsEnabled } from '../employer-source-config.js';
import { runApplicationAgent } from './loop.js';
import { outcomeFromRun } from './outcome.js';
import { waitForApplicationSurface } from './observe.js';

/** Public-feed jobs enter the same application agent and submission gate as employer handoffs. */
export async function applyToEmployerJob(page: Page, job: JobListing, profile: CandidateProfile, deps: ApplyDeps,
  options: { runAgent?: typeof runApplicationAgent; guard?: typeof guardExternalNavigations } = {},
): Promise<ApplyOutcome> {
  if (!job.platform || !isEmployerSource(job.platform) || !employerFeedsEnabled(process.env) || !config.allowExternalApply) {
    return { status: 'skipped', jobId: job.id, reason: 'Employer-feed applications are currently restricted to administrator accounts.' };
  }
  if (outsideScope('external')) return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
  if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
  const listing = employerJobIdentity(job.platform, job.url);
  const destination = employerJobIdentity(job.platform, job.applicationUrl ?? job.url);
  if (listing.namespace !== destination.namespace || listing.posting !== destination.posting) throw new Error('The application address is for a different employer job.');
  const before = new Set(page.context().pages());
  const guard = await (options.guard ?? guardExternalNavigations)(page.context());
  try {
    await page.goto(job.applicationUrl ?? job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForApplicationSurface(page, 5_000).catch(() => false);
    const run = await (options.runAgent ?? runApplicationAgent)({ page, job, profile, log: line => console.log(line) });
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
    return outcomeFromRun(run, job.id, page.url(), deps.onFriction);
  } catch (error) {
    if (guard.blocked()) throw new Error(`Employer navigation was blocked: ${guard.blocked()}`);
    throw error;
  } finally {
    for (const tab of page.context().pages()) {
      if (!before.has(tab) && tab !== page) await tab.close().catch(() => {});
    }
    await guard.stop();
  }
}
