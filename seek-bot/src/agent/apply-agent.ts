import type { Page } from 'patchright';
import { workingIn } from '../browser.js';
import { config } from '../config.js';
import { outsideScope, scopeSkipReason } from '../run-scope.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from '../types.js';
import { runApplicationAgent } from './loop.js';
import { outcomeFromRun } from './outcome.js';
import { approvedSeekReviewUrl } from '../application-review.js';

/**
 * Agent-driven replacement for `applyToJob`.
 *
 * Same signature and same `ApplyOutcome` contract as the deterministic version
 * in apply.ts, so main.ts, the dashboard and the e2e harness can switch between
 * them without changing anything downstream.
 */

export interface ApplyDeps {
  onFriction: (kind: 'captcha' | 'identity' | 'login') => void;
}

/**
 * SEEK pads button labels with invisible formatting characters — the apply CTA
 * literally renders as "Apply⁠" (word joiner). `\s` does not match those, so
 * naive text matching silently fails on every listing.
 */
const clean = (s: string) => s.replace(/[​-‍⁠﻿ ]/g, '').trim();

export async function applyToJobWithAgent(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const tabsBefore = new Set(page.context().pages());
  const runFrom = async (flowPage: Page): Promise<ApplyOutcome> => {
    try {
      const run = await runApplicationAgent({ page: flowPage, job, profile, log: line => console.log(line) });
      console.log(`  agent: ${run.steps} steps · ${run.usage}`);
      return outcomeFromRun(run, job.id, flowPage.url(), deps.onFriction);
    } finally {
      for (const tab of page.context().pages()) {
        if (!tabsBefore.has(tab) && tab !== page) await tab.close().catch(() => {});
      }
      await workingIn(page);
    }
  };
  const reviewUrl = (!config.dryRun || process.env.REHEARSE === 'true') && !outsideScope('hosted')
    ? approvedSeekReviewUrl(job) : undefined;
  await page.goto(reviewUrl ?? job.url, { waitUntil: 'domcontentloaded' });
  if (reviewUrl) {
    // The agent inspects the saved form and retains the exact-content gate.
    // An expired draft can still fall back to the original listing normally.
    return runFrom(page);
  }
  await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector('[data-automation="job-detail-apply"]')) ||
        Boolean(document.body?.innerText.trim()),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {});

  /**
   * This one selector stays deterministic on purpose.
   *
   * Reading the CTA's label *before* clicking it is what lets the bot classify
   * an external application and report `off-platform` having entered nothing
   * anywhere. An agent that had to click in order to find out would already
   * have landed on the employer's ATS — which is exactly the guarantee the
   * project makes. Everything after this point is the agent's.
   */
  const applyCta = page.locator('[data-automation="job-detail-apply"]').first();
  {
    // Only product scope/access is decided here. Missing controls, prior
    // applications and listing recovery belong to the applying agent.
    if (await applyCta.count()) {
      const label = clean(await applyCta.innerText().catch(() => ''));
      job.applicationMode = /quick\s*apply/i.test(label) ? 'hosted' : 'external';
    }
    if (job.applicationMode && job.applicationMode !== 'unknown' && outsideScope(job.applicationMode)) {
      return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
    }
    if (job.applicationMode === 'external' && !config.allowExternalApply) {
      return { status: 'off-platform', jobId: job.id, redirectedTo: job.applicationUrl ?? job.url };
    }
    if (config.dryRun && process.env.REHEARSE !== 'true') return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
    return runFrom(page);
  }
}
