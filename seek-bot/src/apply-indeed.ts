import type { Page } from 'patchright';
import type { ApplyDeps } from './agent/apply-agent.js';
import { runApplicationAgent } from './agent/loop.js';
import { outcomeFromRun } from './agent/outcome.js';
import { workingIn } from './browser.js';
import { config } from './config.js';
import { outsideScope, scopeSkipReason } from './run-scope.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

/**
 * Indeed applications, driven by the same agent that drives SEEK's.
 *
 * What is Indeed-specific is small and stays here: the listing panel opens
 * from a search URL carrying the job key (`/jobs?vjk=`), because a bare
 * `/viewjob` navigation trips Cloudflare; the panel's CTA says whether Indeed
 * hosts the form ("Apply with Indeed", or "Continue application" for one
 * started earlier) or the employer does ("Apply on company site"); and the
 * form opens in a new tab. Everything after that is a form wizard like any
 * other, and the agent reads it, fills it, reacts to what the form says, and
 * stops at the terminal submit in a rehearsal. A hand-written driver for the
 * wizard was replaced by this: every step Indeed changed broke it, and every
 * fix it needed was one the agent already had.
 */

/**
 * Visible apply controls whose accessible name matches. Indeed currently
 * renders the AU listing CTA as an anchor, while older layouts and some
 * resumed applications render it as a button.
 */
function byName(page: Page, pattern: RegExp) {
  return page.getByRole('button', { name: pattern })
    .or(page.getByRole('link', { name: pattern }));
}

export async function applyToIndeedJob(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const tabsBefore = new Set(page.context().pages());
  const runFrom = async (applyPage: Page): Promise<ApplyOutcome> => {
    try {
      const run = await runApplicationAgent({ page: applyPage, job, profile, mailboxContext: deps.mailboxContext, log: line => console.log(line) });
      console.log(`  agent: ${run.steps} steps · ${run.usage}`);
      return outcomeFromRun(run, job.id, applyPage.url(), deps.onFriction);
    } finally {
      for (const tab of page.context().pages()) {
        if (!tabsBefore.has(tab) && tab !== page) await tab.close().catch(() => {});
      }
      await workingIn(page);
    }
  };
  const location = config.search.location || 'Australia';
  await page.goto(`${config.indeedBase}/jobs?l=${encodeURIComponent(location)}&vjk=${encodeURIComponent(job.id)}`, {
    waitUntil: 'domcontentloaded',
  });

  {
    const hosted = await byName(page, /^(apply now|apply with indeed|continue application)/i).count() > 0;
    const external = await byName(page, /^apply on company site/i).count() > 0;
    if (hosted) job.applicationMode = 'hosted';
    else if (external) job.applicationMode = 'external';
    if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
      return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
    }
    if (job.applicationMode === 'external' && !config.allowExternalApply) {
      return { status: 'off-platform', jobId: job.id, redirectedTo: job.applicationUrl ?? job.url };
    }
    if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'DRY_RUN (set REHEARSE=true to fill forms)' };
    // No pre-judge, CAPTCHA wait or already-applied veto: the same agent
    // owns the listing, form, recovery and final outcome in this experiment.
    return runFrom(page);
  }
}
