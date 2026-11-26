import type { Page } from 'patchright';
import type { ApplyOutcome, CandidateProfile, JobListing } from '../types.js';
import type { ApplyDeps } from './apply-agent.js';
import { config } from '../config.js';
import { outsideScope, scopeSkipReason } from '../run-scope.js';
import { assertExternalJobUrl, guardExternalNavigations } from '../external-url.js';
import { jobBoardForUrl } from '../job-board-url.js';
import { employerJobIdentity } from '../employer-feeds.js';
import { isEmployerSource, employerFeedsEnabled } from '../employer-source-config.js';
import { runApplicationAgent } from './loop.js';
import { outcomeFromRun } from './outcome.js';
import { waitForApplicationSurface } from './observe.js';
import { captureApplicationFailure } from '../application-diagnostics.js';
import { refreshMatchedApplication } from '../matched-application.js';

/** Public feeds and already-discovered external forms share the same applying agent. */
export async function applyToEmployerJob(page: Page, job: JobListing, profile: CandidateProfile, deps: ApplyDeps,
  options: { runAgent?: typeof runApplicationAgent; guard?: typeof guardExternalNavigations;
    refresh?: (job: JobListing) => Promise<JobListing> } = {},
): Promise<ApplyOutcome> {
  if (!config.allowExternalApply) return { status: 'skipped', jobId: job.id, reason: 'Employer-site applications are off for this run.' };
  const feed = job.platform && isEmployerSource(job.platform) ? job.platform : null;
  if (feed && !employerFeedsEnabled(process.env)) return { status: 'skipped', jobId: job.id, reason: 'This employer feed is disabled for this run.' };
  if (outsideScope('external')) return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
  if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
  if (options.refresh) {
    const refreshed = await refreshMatchedApplication(job, await options.refresh(job), profile);
    if ('outcome' in refreshed) return refreshed.outcome;
    // Keep coordinator accounting and recovery metadata on the same reviewed job.
    delete job.fitReview;
    Object.assign(job, refreshed.job);
  }
  let url = job.applicationUrl ?? job.url;
  let agentJob = job;
  if (feed) {
    // The provider owns the vacancy identity. Its current Apply link can lead to
    // any form, including a different host or a shared application URL.
    employerJobIdentity(feed, job.url);
    url = job.url;
    if (job.applicationUrl && job.applicationUrl !== url) agentJob = { ...job, applicationUrl: url };
  } else if (jobBoardForUrl(url)) {
    throw new Error('Native board applications must use their connected board.');
  } else {
    await assertExternalJobUrl(url);
  }
  const before = new Set<Page>();
  let guard: Awaited<ReturnType<typeof guardExternalNavigations>> | undefined;
  try {
    for (const tab of page.context().pages()) before.add(tab);
    guard = await (options.guard ?? guardExternalNavigations)(page.context());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForApplicationSurface(page, 5_000).catch(() => false);
    const run = await (options.runAgent ?? runApplicationAgent)({ page, job: agentJob, profile, log: line => console.log(line) });
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
    return outcomeFromRun(run, job.id, page.url(), deps.onFriction);
  } catch (error) {
    captureApplicationFailure(page, job.id, error, { stage: 'employer-application' });
    if (guard?.blocked()) throw new Error(`Employer navigation was blocked: ${guard.blocked()}`);
    throw error;
  } finally {
    try {
      for (const tab of page.context().pages()) {
        if (!before.has(tab) && tab !== page) await tab.close().catch(() => {});
      }
    } finally {
      await guard?.stop();
    }
  }
}
