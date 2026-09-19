import type { Page } from 'patchright';
import { config } from './config.js';
import { waitForInteractiveSurface, workingIn } from './browser.js';
import { judgePage, WALL_STATES } from './blocker.js';
import type { ApplyDeps } from './agent/apply-agent.js';
import { runApplicationAgent } from './agent/loop.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import { outsideScope, scopeSkipReason } from './run-scope.js';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

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

/** Visible buttons whose accessible name matches, trimmed/case-folded. */
function byName(page: Page, pattern: RegExp) {
  return page.getByRole('button', { name: pattern });
}

async function detectAlreadyApplied(page: Page): Promise<boolean> {
  const count = await page
    .locator('text=/you applied|already applied|application submitted/i')
    .count()
    .catch(() => 0);
  return count > 0;
}

/** The wizard lives here; a click that lands anywhere else did not open it. */
const APPLY_FLOW_URL = /smartapply\.indeed\.com|\/indeedapply\//i;
/** An employer's site is anywhere that is not Indeed; the search page with a changed query string is not it. */
const OFF_INDEED_URL = /^https?:\/\/(?![^/]*\bindeed\.com)/i;

/**
 * Opens an apply CTA and returns the page the flow landed on, or null when
 * nothing opened. "Apply with Indeed" opens a new tab; an employer's own site
 * may open a tab or replace this one. The result is checked against
 * `expected` before it is trusted: a click that opened nothing once left the
 * search page to be read as an application form.
 */
async function openApplyFlow(page: Page, applyCta: ReturnType<typeof byName>, expected: RegExp): Promise<Page | null> {
  const popupPromise = page.context().waitForEvent('page', { timeout: 12_000 }).catch(() => null);
  await applyCta.first().scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
  const clicked = await applyCta.first().click({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!clicked) return null;
  const popup = await popupPromise;
  const target = popup ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  const landed = await target
    .waitForURL((url) => expected.test(url.href) || /secure\.indeed\.com\/auth/i.test(url.href), { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    if (popup) await popup.close().catch(() => {});
    return null;
  }
  await waitForInteractiveSurface(target);
  return target;
}

export async function applyToIndeedJob(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const tabsBefore = new Set(page.context().pages());
  const location = config.search.location || 'Australia';
  await page.goto(`${config.indeedBase}/jobs?l=${encodeURIComponent(location)}&vjk=${encodeURIComponent(job.id)}`, {
    waitUntil: 'domcontentloaded',
  });

  const panelReady = await page
    .getByRole('heading', { name: /job post$/i })
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!panelReady) {
    /**
     * Say what the page is rather than guessing. A whole run once skipped
     * every listing as "did not load" and nothing in the log said whether
     * Indeed was slow, the job had gone, or Cloudflare had stepped in. A
     * wall is friction, and repeated friction stops Indeed for the run.
     */
    const verdict = await judgePage(page, `the Indeed listing "${job.title}"`).catch(() => null);
    console.log(`  · listing panel did not appear at ${page.url()}: ${verdict ? `${verdict.state} — ${verdict.reason}` : 'page could not be judged'}`);
    if (verdict && WALL_STATES.has(verdict.state)) {
      deps.onFriction(verdict.state as 'captcha' | 'identity' | 'login');
      return { status: 'needs-human', jobId: job.id, reason: `${verdict.state === 'captcha' ? 'CAPTCHA' : 'Verification'} challenge — ${verdict.reason}`, url: page.url() };
    }
    return {
      status: 'skipped',
      jobId: job.id,
      reason: verdict?.state === 'removed' ? `Listing unavailable: ${verdict.reason}` : 'listing panel did not load in time (expired, removed, or a slow page load)',
    };
  }

  if (await detectAlreadyApplied(page)) {
    return { status: 'skipped', jobId: job.id, reason: 'Indeed reports already applied' };
  }

  // "Continue application" is what Indeed shows once a flow was started and left; same wizard, resumed.
  const indeedApplyCta = byName(page, /^(apply with indeed|continue application)/i);
  const externalCta = byName(page, /^apply on company site/i);
  const hosted = (await indeedApplyCta.count()) > 0;
  // The panel's own button is the truth about where the form lives; discovery only guesses, and cannot when Indeed's data is absent.
  job.applicationMode = hosted ? 'hosted' : 'external';
  if (outsideScope(job.applicationMode)) {
    return { status: 'skipped', jobId: job.id, reason: scopeSkipReason() };
  }
  if (!hosted) {
    if (!(await externalCta.count())) {
      return { status: 'skipped', jobId: job.id, reason: 'no apply control found (expired?)' };
    }
    if (!config.allowExternalApply) {
      const label = clean((await externalCta.first().innerText().catch(() => '')) || 'Apply on company site');
      return { status: 'off-platform', jobId: job.id, redirectedTo: `${label} → ${job.applicationUrl ?? job.url}` };
    }
  }

  if (config.dryRun && process.env.REHEARSE !== 'true') {
    return { status: 'skipped', jobId: job.id, reason: 'DRY_RUN (set REHEARSE=true to fill forms)' };
  }

  const cta = hosted ? indeedApplyCta : externalCta;
  const expected = hosted ? APPLY_FLOW_URL : OFF_INDEED_URL;
  // One more try after a scroll before giving up: the panel's button sits under a sticky header on some listings.
  const applyPage = (await openApplyFlow(page, cta, expected)) ?? (await openApplyFlow(page, cta, expected));
  if (!applyPage) {
    return {
      status: 'needs-human',
      jobId: job.id,
      reason: `Indeed's "${hosted ? 'Apply with Indeed' : 'Apply on company site'}" button did not open the application form.`,
      url: page.url(),
    };
  }

  try {
    const run = await runApplicationAgent({
      page: applyPage,
      job,
      profile,
      log: (line) => console.log(line),
    });
    console.log(`  agent: ${run.steps} steps · ${run.usage}`);
    const actions = run.actions.length ? { actions: run.actions } : {};

    switch (run.outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          jobId: job.id,
          at: new Date().toISOString(),
          ...(run.site ? { site: run.site } : {}),
          coverLetter: run.coverLetter,
          answers: run.captured,
          ...actions,
        };
      case 'rehearsed':
        return { status: 'rehearsed', jobId: job.id, coverLetter: run.coverLetter, answers: run.captured, stoppedAt: run.outcome.stoppedAt, ...actions };
      case 'off-platform':
        return { status: 'off-platform', jobId: job.id, redirectedTo: run.outcome.redirectedTo, ...actions };
      case 'already-applied':
        return { status: 'already-applied', jobId: job.id, reason: run.outcome.reason, ...actions };
      case 'skipped':
        return { status: 'skipped', jobId: job.id, reason: run.outcome.reason, ...actions };
      case 'needs-human':
      default: {
        // Friction feeds the run-level abort counter, so repeated walls stop Indeed for the run.
        if (/captcha/i.test(run.outcome.reason)) deps.onFriction('captcha');
        else if (/identity|work-rights/i.test(run.outcome.reason)) deps.onFriction('identity');
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: run.outcome.reason,
          url: applyPage.url(),
          ...(run.outcome.questions?.length ? { questions: run.outcome.questions } : {}),
          ...actions,
        };
      }
    }
  } finally {
    /**
     * Leaving the popup open backgrounds the original tab, and Chrome
     * throttles background tabs' timers/hydration — a real failure mode
     * observed live: after one job left its smartapply.indeed.com tab open,
     * every subsequent `page.goto()` on the original tab stopped rendering
     * the job panel in time. Always close the popup and refocus the main
     * page, on every exit path, so later candidates in the same run are not
     * silently starved of foreground priority.
     */
    for (const tab of page.context().pages()) {
      if (!tabsBefore.has(tab) && tab !== page) await tab.close().catch(() => {});
    }
    await workingIn(page);
  }
}
