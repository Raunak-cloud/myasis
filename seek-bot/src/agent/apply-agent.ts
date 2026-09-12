import type { Locator, Page } from 'patchright';
import { config } from '../config.js';
import { waitForApplicationSurface } from './observe.js';
import { coverLetterForJob } from '../llm.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from '../types.js';
import { runApplicationAgent } from './loop.js';

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

/** Opens a SEEK Apply CTA whether the employer flow replaces the tab or opens a new one. */
async function openApplyFlow(page: Page, applyCta: Locator): Promise<Page> {
  const href = await applyCta.getAttribute('href').catch(() => null);
  if (href) {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' });
    await waitForApplicationSurface(page);
    return page;
  }
  const popup = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);

  /**
   * A click that will not land is not the end of the application.
   *
   * Three applications died on "locator.click: Timeout 30000ms exceeded" —
   * the button was there, `count()` found it, and it still could not be
   * pressed: covered by a consent banner, under a sticky header, or replaced
   * by a re-render between reading its label and reaching for it. The default
   * thirty-second wait then threw a Playwright error at the candidate.
   *
   * The agent that runs next looks at this same page and can find the control
   * for itself, which is the whole reason it exists. So this tries the quick
   * way, then tries once more after scrolling it into view, and otherwise
   * hands the page over rather than giving up on the job.
   */
  let clicked = await applyCta.click({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!clicked) {
    await applyCta.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    clicked = await applyCta.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }

  const opened = await popup;
  const target = opened ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  // Still on the listing when the click never landed; the agent starts there
  // and opens the form itself, so there is no application surface to wait for.
  if (clicked) await waitForApplicationSurface(target);
  return target;
}

export async function applyToJobWithAgent(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
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
  if (!(await applyCta.count())) {
    return { status: 'skipped', jobId: job.id, reason: 'No apply button on the listing — it may have closed.' };
  }

  const label = clean(await applyCta.innerText().catch(() => ''));
  const externalCta = !/quick\s*apply/i.test(label);
  if (externalCta && !config.allowExternalApply) {
    const href = await applyCta.getAttribute('href').catch(() => null);
    return {
      status: 'off-platform',
      jobId: job.id,
      redirectedTo: `${label || 'Apply'} → ${href ?? 'employer site'}`,
    };
  }

  if (config.dryRun && process.env.REHEARSE !== 'true') {
    return { status: 'skipped', jobId: job.id, reason: 'Dry run — forms are not opened.' };
  }

  // Draft while the application UI opens and renders — independent work,
  // overlapped rather than serialised.
  const prefetchedLetter = coverLetterForJob(job, profile).then(
    (letter) => ({ letter }),
    (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );

  const flowPage = await openApplyFlow(page, applyCta);

  try {
    const run = await runApplicationAgent({
      page: flowPage,
      job,
      profile,
      prefetchedLetter,
      log: (line) => console.log(line),
    });

    console.log(`  agent: ${run.steps} steps · ${run.usage}`);

    switch (run.outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          jobId: job.id,
          at: new Date().toISOString(),
          coverLetter: run.coverLetter,
          answers: run.captured,
        };
      case 'rehearsed':
        return {
          status: 'rehearsed',
          jobId: job.id,
          coverLetter: run.coverLetter,
          answers: run.captured,
          stoppedAt: run.outcome.stoppedAt,
        };
      case 'off-platform':
        return { status: 'off-platform', jobId: job.id, redirectedTo: run.outcome.redirectedTo };
      case 'already-applied':
        return { status: 'already-applied', jobId: job.id, reason: run.outcome.reason };
      case 'skipped':
        return { status: 'skipped', jobId: job.id, reason: run.outcome.reason };
      case 'needs-human':
      default: {
        // Friction signals feed the run-level abort counter exactly as the
        // deterministic path does, so repeated walls still stop the whole run.
        if (/captcha/i.test(run.outcome.reason)) deps.onFriction('captcha');
        else if (/identity|work-rights/i.test(run.outcome.reason)) deps.onFriction('identity');
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: run.outcome.reason,
          url: flowPage.url(),
          ...(run.outcome.questions?.length ? { questions: run.outcome.questions } : {}),
        };
      }
    }
  } finally {
    if (flowPage !== page) await flowPage.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}
