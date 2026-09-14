import type { Page } from 'patchright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import {
  captureInteractivePageState,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from './browser.js';
import { judgePage, WALL_STATES } from './blocker.js';
import { extractFields, fillField, FieldRejectedError, pageSummary } from './dom.js';
import { answerFields, classifyPage, coverLetterForJob } from './llm.js';
import { rewriteLongText } from './humanizer.js';
import { RESUME_DIR, pickResumeForJob } from './resume.js';
import type { ApplyDeps } from './agent/apply-agent.js';
import { runApplicationAgent } from './agent/loop.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

const MAX_STEPS = 12;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * How Indeed's apply flow actually works (verified live against au.indeed.com,
 * signed in, Sep 2026 — rehearsal only, nothing was ever submitted):
 *
 * The job's detail panel — with a real, clickable Apply button — can be
 * reopened directly and safely via `/jobs?l=Australia&vjk=<jobkey>` (a normal
 * *search results* URL, just with the target job's key pre-set in `vjk`).
 * Indeed's own client JS reads `vjk` on load and renders that job's panel via
 * the same in-page fetch discovery-indeed.ts uses — verified this opens the
 * exact right job even with no `q=` keyword at all. This deliberately avoids
 * `page.goto()` on a bare `/viewjob?jk=...` URL, which trips a Cloudflare
 * Turnstile "Additional Verification Required" interstitial almost
 * immediately (reproduced live) because it lacks the session-context params a
 * real in-app navigation always carries.
 *
 * The panel's CTA reads "Apply with Indeed" when Indeed hosts its own Easy
 * Apply flow, or "Apply on company site" when the job hands off to the
 * employer's own site/ATS — both rendered as a plain `<button>` with no
 * stable `data-testid` found, so they are matched by accessible role+name
 * (`getByRole('button', { name: /.../ })`), which is what the live
 * accessibility tree actually exposes. "Apply with Indeed" opens the flow in
 * a NEW TAB at `smartapply.indeed.com/beta/indeedapply/...` — confirmed on
 * two different real listings.
 *
 * SmartApply is a multi-step wizard with a `role="progressbar"` and a URL
 * path that names the current step, e.g.:
 *   .../form/resume-selection-module/resume-selection   (résumé choice)
 *   .../form/questions-module/questions/<n>              (screening Qs +
 *                                                          an optional "Add
 *                                                          cover letter" box,
 *                                                          both plain
 *                                                          <label for>-linked
 *                                                          <input>/<textarea>
 *                                                          elements — dom.ts's
 *                                                          generic reader
 *                                                          handles these
 *                                                          unmodified)
 *   .../form/review-module                                (terminal: a
 *                                                          read-only preview
 *                                                          iframe plus the
 *                                                          real "Submit your
 *                                                          application"
 *                                                          button)
 * A job with nothing left to ask (résumé + contact info already on file, no
 * employer questions) can land straight on the review step at 100% progress —
 * confirmed live. "Save and close" exits without submitting, behind a
 * "Save application progress" / "Don't save" confirmation — used here to
 * leave no residue after a rehearsal.
 *
 * reCAPTCHA is on every single step: a hidden `textarea[name="g-recaptcha-
 * response"]` and a footer "This site is protected by reCAPTCHA" notice are
 * present even on ordinary steps with no visible challenge — that is Google's
 * invisible v3-style integration, not friction. Neither of the two real
 * flows exercised here (one with screening questions, one without) ever
 * surfaced a *visible* checkbox/image challenge, so friction detection below
 * only trips on an actual visible challenge — the same generic reCAPTCHA/
 * Cloudflare text and iframe patterns SEEK's apply.ts already watches for,
 * plus the Cloudflare Turnstile wording seen on the blocked `/viewjob` nav.
 */

async function detectFriction(page: Page): Promise<{ kind: 'captcha' | 'identity' | 'login'; reason: string } | null> {
  const verdict = await judgePage(page, 'an Indeed application step');
  return WALL_STATES.has(verdict.state) ? { kind: verdict.state as 'captcha' | 'identity' | 'login', reason: verdict.reason } : null;
}

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

/** The panel's own URL never leaves au.indeed.com, so an external CTA is the only off-platform signal. */
const CONTINUE_LABEL = /^continue$/i;
/** The wizard lives here; a click that lands anywhere else did not open it. */
const APPLY_FLOW_URL = /smartapply\.indeed\.com|\/indeedapply\//i;
const onReviewStep = (url: string) => /\/beta\/indeedapply\/form\/review-module/.test(url);

/**
 * The review step's submit control, wherever Indeed put it.
 *
 * Its exact label has changed before ("Submit your application", "Submit
 * application", "Submit"), and two live applications stopped on this step
 * with the button in plain view because the name did not match. The review
 * step is terminal, so any control there that says Submit is the one; the
 * preview sits in an iframe, so frames are searched too.
 */
async function findSubmitControl(page: Page) {
  for (const scope of [page, ...page.frames()]) {
    const named = scope.getByRole('button', { name: /submit/i });
    if (await named.count().catch(() => 0)) return named.first();
    const byText = scope.locator('button:has-text("Submit"), [role="button"]:has-text("Submit"), input[type="submit"]');
    if (await byText.count().catch(() => 0)) return byText.first();
  }
  return null;
}

async function clickContinueOrSubmit(page: Page): Promise<'advanced' | 'submit-withheld' | 'none'> {
  const onReview = onReviewStep(page.url());
  const submitBtn = onReview ? await findSubmitControl(page) : null;
  if (onReview && !submitBtn) {
    const shown = await page
      .evaluate(() =>
        [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 20),
      )
      .catch(() => [] as string[]);
    console.log(`  · review step has no submit control; buttons: ${shown.join(' | ') || '(none)'}; frames: ${page.frames().length}`);
  }
  if (onReview && submitBtn) {
    if (config.dryRun) return 'submit-withheld';
    const state = await submitBtn
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const atPoint = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          tag: el.tagName.toLowerCase(),
          disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
          visible: rect.width > 0 && rect.height > 0,
          onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight,
          covered: Boolean(atPoint && atPoint !== el && !el.contains(atPoint)),
          coveredBy: atPoint && atPoint !== el && !el.contains(atPoint) ? `${atPoint.tagName.toLowerCase()}.${String((atPoint as HTMLElement).className).slice(0, 40)}` : '',
        };
      })
      .catch(() => null);
    console.log(`  · submitting: "${(await submitBtn.innerText().catch(() => 'Submit')).trim()}" ${state ? JSON.stringify(state) : ''}`);
    const before = await captureInteractivePageState(page);
    const beforeUrl = page.url();
    let clicked = await submitBtn
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch((error: Error) => {
        console.log(`  · submit click did not land: ${error.message.split('\n')[0].slice(0, 160)}`);
        return false;
      });
    if (!clicked) {
      await submitBtn.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      clicked = await submitBtn
        .click({ timeout: 5_000, force: true })
        .then(() => true)
        .catch((error: Error) => {
          console.log(`  · forced submit click did not land either: ${error.message.split('\n')[0].slice(0, 160)}`);
          return false;
        });
    }
    if (clicked) {
      /**
       * A submission takes a moment. Two live applications were reported as
       * stuck while Indeed was still sending them: the review page was read
       * again before it had gone anywhere. Wait for the wizard to leave the
       * form, or for the page to say the application went, before deciding.
       */
      await page
        .waitForFunction(
          () =>
            !/\/beta\/indeedapply\/form\//.test(location.href) ||
            /application (has been |was )?(submitted|sent)|you'?ve applied|successfully applied|application received/i.test(document.body?.innerText ?? ''),
          undefined,
          { timeout: 30_000, polling: 500 },
        )
        .catch(() => {});
      await waitForInteractivePageChange(page, before);
      await waitForInteractiveSurface(page, 4_000);
      console.log(`  · after submit: ${page.url()}${page.url() === beforeUrl ? ' (still on the review step)' : ''}`);
      return 'advanced';
    }
  }

  const continueBtn = byName(page, CONTINUE_LABEL);
  if (await continueBtn.count()) {
    /**
     * Disabled is often "not yet": the step is still processing something,
     * such as a résumé that was just added and is being converted. Give it
     * the time an upload takes before concluding the step is stuck.
     */
    const enabled = await waitUntilEnabled(continueBtn.first(), 25_000);
    if (!enabled) console.log('  · Continue stayed disabled for 25s');
    if (enabled) {
      const before = await captureInteractivePageState(page);
      const beforeUrl = page.url();
      const clicked = await continueBtn
        .first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) console.log('  · Continue could not be clicked');
      if (clicked) {
        /**
         * The wizard names its step in the URL, so a step is only over when
         * the URL has moved on. Waiting for the content alone returned while
         * the old step was still on screen, the loop re-read it and started
         * filling again, and the page changed underneath the second fill.
         */
        await page.waitForURL((url) => url.href !== beforeUrl, { timeout: 12_000 }).catch(() => {});
        await waitForInteractivePageChange(page, before);
        await waitForInteractiveSurface(page, 4_000);
        if (page.url() === beforeUrl) {
          const complaints = await page
            .evaluate(() =>
              [...document.querySelectorAll('[role="alert"], [aria-live], [class*="error" i], [id*="error" i]')]
                .filter((el) => (el as HTMLElement).offsetParent !== null)
                .map((el) => ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim())
                .filter((text) => text && text.length < 200)
                .slice(0, 5),
            )
            .catch(() => [] as string[]);
          console.log(`  · Continue did not move the step${complaints.length ? `; the form says: ${complaints.join(' | ')}` : ''}`);
        }
        return 'advanced';
      }
    }
  }
  return 'none';
}

async function waitUntilEnabled(button: ReturnType<typeof byName>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await button.isEnabled().catch(() => false)) return true;
    await jitter(400, 700);
  }
  return false;
}

/**
 * Diagnostic only (INDEED_REVIEW_DEBUG=1, rehearsal): watches the review
 * step for a minute and writes what the submit control is doing, because a
 * live run cannot be paused to look. Never clicks anything.
 */
async function describeReviewStep(page: Page): Promise<void> {
  const snapshot = () =>
    page
      .evaluate(() => {
        const vis = (el: Element) => el.getClientRects().length > 0;
        const btn = [...document.querySelectorAll('button')].find((b) => /submit/i.test(b.innerText));
        const rect = btn?.getBoundingClientRect();
        const at = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          submit: btn
            ? {
                text: btn.innerText.trim(),
                disabled: btn.disabled,
                ariaDisabled: btn.getAttribute('aria-disabled'),
                coveredBy: at && at !== btn && !btn.contains(at) ? `${at.tagName.toLowerCase()}.${String((at as HTMLElement).className).slice(0, 50)}` : '',
              }
            : null,
          checkboxes: [...document.querySelectorAll('input[type=checkbox]')].map(
            (c) => `${((c as HTMLInputElement).labels?.[0]?.innerText || '').slice(0, 40)}=${(c as HTMLInputElement).checked}${(c as HTMLInputElement).required ? ' required' : ''}`,
          ),
          headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((h) => (h as HTMLElement).innerText.trim()).slice(0, 5),
          overlays: [...document.querySelectorAll('[class*="loading" i], [class*="spinner" i], [aria-busy="true"], [role="progressbar"]')]
            .filter(vis)
            .map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 40)}:${((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').slice(0, 40)}`)
            .slice(0, 5),
          iframes: [...document.querySelectorAll('iframe')].map((f) => ((f as HTMLIFrameElement).src || f.title || '').slice(0, 60)),
          text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
        };
      })
      .catch((error: Error) => ({ error: error.message }));
  for (const seconds of [0, 10, 25, 45, 60]) {
    if (seconds) await new Promise((r) => setTimeout(r, seconds === 10 ? 10_000 : 15_000));
    console.log(`  · review after ${seconds}s: ${JSON.stringify(await snapshot())}`);
  }
  await page.screenshot({ path: resolve(config.dataDir, 'indeed-review-debug.png'), fullPage: true }).catch(() => {});
}

/** Exits an in-progress application cleanly, without submitting. Best-effort. */
async function saveAndCloseWithoutSubmitting(page: Page): Promise<void> {
  try {
    const saveClose = byName(page, /^save and close$/i);
    if (!(await saveClose.count())) return;
    await saveClose.first().click({ timeout: 5_000 });
    const dontSave = page.getByRole('button', { name: /^don'?t save$/i });
    await dontSave.first().waitFor({ state: 'visible', timeout: 5_000 });
    await dontSave.first().click({ timeout: 5_000 });
    await jitter(400, 900);
  } catch {
    // Best-effort tidy-up only — never let this affect the outcome already computed.
  }
}

/**
 * Opens an apply CTA and returns the page the flow landed on, or null when
 * nothing opened.
 *
 * "Apply with Indeed" opens a new tab; an employer's own site may open a tab
 * or replace this one. Either way the result is checked against `expected`
 * before it is trusted: one live run clicked the button, saw no tab inside
 * the wait, fell back to the search page it was standing on, and then read
 * the search box and a "how relevant are these jobs?" widget as screening
 * questions. A click that did not open the form is a fact to report, not a
 * page to fill in.
 */
async function openApplyFlow(
  page: Page,
  applyCta: ReturnType<typeof byName>,
  expected: RegExp | null,
): Promise<Page | null> {
  const startUrl = page.url();
  const popupPromise = page.context().waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await applyCta.first().scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
  const clicked = await applyCta.first().click({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!clicked) return null;
  const popup = await popupPromise;
  const target = popup ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForInteractiveSurface(target);
  const landed = await target
    .waitForURL((url) => (expected ? expected.test(url.href) : url.href !== startUrl), { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (landed) return target;
  if (popup) await popup.close().catch(() => {});
  return null;
}

type ResumeOutcome = { status: 'kept-default' | 'selected' } | { status: 'unavailable'; wanted: string; detail: string };

/**
 * Résumé choice is deterministic business logic, not something to hand to
 * the model as a "screening question" — mirrors resume.ts's SEEK philosophy.
 * The radios here are plain `<input type=radio>` (dom.ts already extracts
 * them as a generic radio field), so this only needs to pick the SEEK-style
 * `config.resume.select` override; the upload UI behind "Resume options" was
 * not reachable during live verification, so an unmatched request is reported
 * rather than guessed at.
 */
async function handleResumeStep(page: Page, job: JobListing, profile: CandidateProfile): Promise<ResumeOutcome> {
  const wanted = await pickResumeForJob(job, profile);
  const radios = page.locator('input[type=radio]');

  /** Picks the radio whose label carries the wanted name; false when none does. */
  const selectWanted = async (): Promise<boolean> => {
    if (!wanted) return false;
    const needles = [wanted.label, wanted.fileName]
      .map((s) => s.toLowerCase().replace(/\.(pdf|docx?|rtf)$/i, '').trim())
      .filter(Boolean);
    const count = await radios.count();
    for (let i = 0; i < count; i++) {
      const label = clean(
        await radios
          .nth(i)
          .evaluate((el) => (el.closest('label')?.textContent ?? '') || '')
          .catch(() => ''),
      ).toLowerCase();
      if (needles.some((needle) => label.includes(needle))) {
        await radios.nth(i).click({ force: true }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  if (await selectWanted()) return { status: 'selected' };

  /**
   * The step has a file input (verified live: "Add a resume" is a plain
   * `<input type=file>`), so the résumé chosen for this job can be added
   * the way SEEK's picker adds one, and it then appears in the list.
   */
  const localPath = wanted ? resolve(RESUME_DIR, wanted.fileName) : '';
  const fileInput = page.locator('input[type=file]').first();
  if (wanted && existsSync(localPath) && (await fileInput.count())) {
    const uploaded = await fileInput
      .setInputFiles(localPath)
      .then(() => true)
      .catch(() => false);
    if (uploaded) {
      await page.waitForFunction(
        (name) => [...document.querySelectorAll('label')].some((l) => (l.textContent ?? '').includes(name)),
        wanted.fileName.replace(/\.(pdf|docx?|rtf)$/i, ''),
        { timeout: 20_000 },
      ).catch(() => {});
      if (await selectWanted()) return { status: 'selected' };
    }
  }

  /**
   * The résumé already on Indeed is the candidate's own; using it is what
   * they would do at this step themselves. Stopping here cost every Indeed
   * application on one live run, over a file name that differed by a "(2)".
   */
  const checked = await radios.locator(':scope:checked').count().catch(() => 0);
  if (checked > 0) return { status: 'kept-default' };
  if (await radios.count()) {
    await radios.first().click({ force: true }).catch(() => {});
    return { status: 'kept-default' };
  }
  return wanted
    ? { status: 'unavailable', wanted: wanted.label, detail: existsSync(localPath) ? 'the step offered nowhere to add it' : `local file data/resumes/${wanted.fileName} is missing too` }
    : { status: 'unavailable', wanted: 'any résumé', detail: 'the Indeed profile has none on file' };
}

async function detectConfirmation(page: Page): Promise<boolean> {
  const body = await page.locator('body').innerText().catch(() => '');
  const said = /application (has been |was )?(submitted|sent)|you'?ve applied|successfully applied|application received/i.test(body);
  if (/\/beta\/indeedapply\/form\//.test(page.url())) return said && !/review your application/i.test(body); // still inside the wizard unless it says otherwise
  return said || /\/post-?apply|\/applied|confirmation/i.test(page.url());
}

/**
 * Drives one Indeed Easy Apply flow end to end. Mirrors apply.ts's structure
 * and outcome contract exactly — same `ApplyOutcome` union, same
 * never-fabricate-an-answer rule via gemini.ts's shared grounding, same
 * withhold-the-final-submit dry-run behaviour.
 */
export async function applyToIndeedJob(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  await page.goto(`${config.indeedBase}/jobs?l=${encodeURIComponent('Australia')}&vjk=${encodeURIComponent(job.id)}`, {
    waitUntil: 'domcontentloaded',
  });

  const panelReady = await page
    .getByRole('heading', { name: /job post$/i })
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!panelReady) {
    return {
      status: 'skipped',
      jobId: job.id,
      reason: 'listing panel did not load in time (expired, removed, or a slow page load)',
    };
  }

  if (await detectAlreadyApplied(page)) {
    return { status: 'skipped', jobId: job.id, reason: 'Indeed reports already applied' };
  }

  // "Continue application" is what Indeed shows once a flow was started and left; same wizard, resumed.
  const indeedApplyCta = byName(page, /^(apply with indeed|continue application)/i);
  const externalCta = byName(page, /^apply on company site/i);
  const hosted = (await indeedApplyCta.count()) > 0;
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

  const prefetchedLetter: Promise<{ letter?: string; error?: Error }> = coverLetterForJob(job, profile).then(
    (letter) => ({ letter }),
    (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );

  // One more try after a scroll before giving up: the panel's button sits under a sticky header on some listings.
  const cta = hosted ? indeedApplyCta : externalCta;
  const expected = hosted ? APPLY_FLOW_URL : null;
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
    if (!hosted) return await applyOnEmployerSite(applyPage, job, profile, deps, prefetchedLetter);
    return await runApplySteps(applyPage, job, profile, deps, prefetchedLetter);
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
    if (applyPage !== page) await applyPage.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}

/**
 * An employer's own site, reached from Indeed. The same agent that handles
 * SEEK's employer-site applications drives it; only the way in differs.
 */
async function applyOnEmployerSite(
  flowPage: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
  prefetchedLetter: Promise<{ letter?: string; error?: Error }>,
): Promise<ApplyOutcome> {
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
      return { status: 'applied', jobId: job.id, at: new Date().toISOString(), coverLetter: run.coverLetter, answers: run.captured };
    case 'rehearsed':
      return { status: 'rehearsed', jobId: job.id, coverLetter: run.coverLetter, answers: run.captured, stoppedAt: run.outcome.stoppedAt };
    case 'off-platform':
      return { status: 'off-platform', jobId: job.id, redirectedTo: run.outcome.redirectedTo };
    case 'already-applied':
      return { status: 'already-applied', jobId: job.id, reason: run.outcome.reason };
    case 'skipped':
      return { status: 'skipped', jobId: job.id, reason: run.outcome.reason };
    default: {
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
}

async function runApplySteps(
  applyPage: Page,
  job: JobListing,
  profile: CandidateProfile,
  deps: ApplyDeps,
  prefetchedLetter: Promise<{ letter?: string; error?: Error }>,
): Promise<ApplyOutcome> {
  const captured: Array<{ question: string; answer: string }> = [];
  let coverLetter: string | undefined;
  let lastUrl = '';
  let lastState = '';
  let stagnant = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let seen = await extractFields(applyPage);
    /**
     * A step with nothing on it is usually a step still drawing itself.
     * Acting on that read sent the fallback classifier a blank page, it
     * pressed Continue, and the next read was of a step already leaving.
     * Give the wizard a few seconds to show its fields or move on.
     */
    if (!seen.length) {
      const startedOn = applyPage.url();
      const until = Date.now() + 6_000;
      while (Date.now() < until && !seen.length && applyPage.url() === startedOn) {
        await jitter(500, 800);
        seen = await extractFields(applyPage);
      }
    }
    const state = JSON.stringify(seen.map(f => [f.label, f.currentValue]));
    console.log(`  · step ${step + 1}: ${applyPage.url().replace(/^https:\/\/smartapply\.indeed\.com\/beta\/indeedapply\//, '')} · ${seen.length ? seen.map((f) => `${f.label} [${f.kind}${f.options?.length ? ` ${f.options.length} options` : ''}]`).join(' | ') : 'no fields'}`);
    if (applyPage.url() === lastUrl && state === lastState) {
      if (++stagnant >= 2) {
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: `stuck on the same step (${applyPage.url()}) — no control advanced the flow`,
          url: applyPage.url(),
        };
      }
    } else {
      stagnant = 0;
    }
    lastUrl = applyPage.url();
    lastState = state;

    if (await detectConfirmation(applyPage)) {
      return { status: 'applied', jobId: job.id, at: new Date().toISOString(), coverLetter, answers: captured };
    }

    /**
     * The review step is the end of a rehearsal, whatever its buttons are
     * called. One live rehearsal reached it, failed to recognise the submit
     * button's current label, asked the model for a next action, and left
     * the wizard through whatever it clicked — landing on the homepage
     * behind a Cloudflare check. Nothing on this step is ever clicked
     * during a rehearsal except Save and close.
     */
    if (config.dryRun && onReviewStep(applyPage.url())) {
      if (process.env.INDEED_REVIEW_DEBUG === '1') await describeReviewStep(applyPage);
      await saveAndCloseWithoutSubmitting(applyPage);
      return { status: 'rehearsed', jobId: job.id, coverLetter, answers: captured, stoppedAt: applyPage.url() };
    }

    const friction = await detectFriction(applyPage);
    if (friction) {
      deps.onFriction(friction.kind);
      return {
        status: 'needs-human',
        jobId: job.id,
        reason: `${friction.kind === 'captcha' ? 'CAPTCHA' : 'Verification'} challenge — ${friction.reason}`,
        url: applyPage.url(),
      };
    }

    if (/\/beta\/indeedapply\/form\/resume-selection-module(\/|$|\?)/.test(applyPage.url())) {
      const outcome = await handleResumeStep(applyPage, job, profile);
      console.log(`  · résumé step: ${outcome.status}${outcome.status === 'unavailable' ? ` (${outcome.detail})` : ''}`);
      if (outcome.status === 'unavailable') {
        return {
          status: 'needs-human',
          jobId: job.id,
          reason:
            `résumé "${outcome.wanted}" is not already on your Indeed profile (${outcome.detail}) and this tool cannot ` +
            `upload one to Indeed's picker unattended. Attach it manually in Indeed's résumé picker, or clear the résumé override to use your default.`,
          url: applyPage.url(),
        };
      }
      captured.push({ question: 'Résumé', answer: outcome.status === 'selected' ? 'selected override' : 'default on file' });
    } else {
      const fields = await extractFields(applyPage);
      const coverLetterField = fields.find((f) => /cover letter/i.test(f.label));
      const answerable = fields.filter(
        (f) => f !== coverLetterField && (f.kind !== 'checkbox' || /agree|consent|privacy|terms|declare/i.test(f.label)),
      );

      if (coverLetterField) {
        const draft = await prefetchedLetter;
        if (draft.error) throw draft.error;
        if (!draft.letter) throw new Error('Cover-letter drafting returned no text.');
        coverLetter = draft.letter;
        try {
          await fillField(applyPage, coverLetterField, coverLetter);
          captured.push({ question: coverLetterField.label, answer: coverLetter });
        } catch (err) {
          return { status: 'needs-human', jobId: job.id, reason: `Cover-letter fill not verified: ${(err as Error).message}`, url: applyPage.url() };
        }
      }

      if (answerable.length) {
        const { answers, injectionSuspected } = await answerFields(answerable, job, profile);
        if (injectionSuspected) console.warn(`  ! injection-shaped text in ${job.company} — ignored, continuing`);

        const ungrounded = answers.filter((a) => !a.grounded);
        if (ungrounded.length) {
          const byRef = new Map(answerable.map((f) => [f.ref, f]));
          const detail = ungrounded
            .map((a) => `"${byRef.get(a.ref)?.label ?? a.ref}"${a.rationale ? ` (${a.rationale})` : ''}`)
            .join('; ');
          return {
            status: 'needs-human',
            jobId: job.id,
            reason: `question not answerable from profile: ${detail}`,
            url: applyPage.url(),
          };
        }

        const stepUrl = applyPage.url();
        let stepMoved = false;
        for (const a of answers) {
          const field = answerable.find((f) => f.ref === a.ref);
          if (!field) continue;
          // The answers belong to the step they were read from; a new step gets read afresh.
          if (applyPage.url() !== stepUrl) {
            console.log(`  · the step moved on before "${field.label}" was filled; re-reading`);
            stepMoved = true;
            break;
          }
          let value = a.value;
          if (field.kind === 'text' || field.kind === 'textarea') {
            try {
              value = await rewriteLongText(value);
            } catch (err) {
              return {
                status: 'needs-human',
                jobId: job.id,
                reason: `could not safely rewrite "${field.label}": ${(err as Error).message}`,
                url: applyPage.url(),
              };
            }
          }
          try {
            console.log(`  · filling "${field.label}"${field.sensitive ? '' : ` with "${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`}`);
            await fillField(applyPage, field, value);
            captured.push({ question: field.label, answer: value });
          } catch (err) {
            /**
             * The form said what was wrong ("Answer must be a valid number"),
             * so the question is asked again with that requirement attached,
             * the way the SEEK agent retries. One more answer, from the same
             * evidence; only a second refusal goes to the person.
             */
            const complaint = err instanceof FieldRejectedError ? err.complaint : '';
            if (complaint) {
              console.log(`  · "${field.label}": the form says "${complaint}"; asking again`);
              const again = await answerFields(
                [{ ...field, label: `${field.label} (the form requires: ${complaint})` }],
                job,
                profile,
              ).catch(() => null);
              const retry = again?.answers.find((candidate) => candidate.ref === field.ref);
              if (retry?.grounded && retry.value) {
                try {
                  console.log(`  · filling "${field.label}" with "${retry.value}"`);
                  await fillField(applyPage, field, retry.value);
                  captured.push({ question: field.label, answer: retry.value });
                  continue;
                } catch (secondErr) {
                  err = secondErr;
                }
              }
            }
            console.log(`  · fill failed at ${applyPage.url()}`);
            return { status: 'needs-human', jobId: job.id, reason: `Field fill not verified: ${(err as Error).message}`, url: applyPage.url() };
          }
        }

        if (stepMoved) continue;

        const formFriction = await detectFriction(applyPage);
        if (formFriction) {
          deps.onFriction(formFriction.kind);
          return {
            status: 'needs-human',
            jobId: job.id,
            reason: `${formFriction.kind === 'captcha' ? 'CAPTCHA' : 'Verification'} challenge — ${formFriction.reason}`,
            url: applyPage.url(),
          };
        }
      }
    }

    const advanced = await clickContinueOrSubmit(applyPage);
    if (advanced === 'advanced') console.log(`  · continued → ${applyPage.url().replace(/^https:\/\/smartapply\.indeed\.com\/beta\/indeedapply\//, '')}`);
    if (advanced === 'submit-withheld') {
      await saveAndCloseWithoutSubmitting(applyPage);
      return { status: 'rehearsed', jobId: job.id, coverLetter, answers: captured, stoppedAt: applyPage.url() };
    }
    if (advanced === 'advanced') continue;

    // Nothing recognised on this step — same Gemini fallback SEEK's apply.ts uses.
    const verdict = await classifyPage(await pageSummary(applyPage));
    console.log(`  [assist] page looks like: ${verdict.kind} — ${verdict.reasoning}`);

    if (verdict.kind === 'confirmation') {
      return { status: 'applied', jobId: job.id, at: new Date().toISOString(), coverLetter, answers: captured };
    }
    if (verdict.humanNeeded) {
      if (verdict.kind === 'captcha') deps.onFriction('captcha');
      return { status: 'needs-human', jobId: job.id, reason: verdict.reasoning, url: applyPage.url() };
    }
    if (verdict.nextAction) {
      const byLabel = applyPage.getByRole('button', { name: new RegExp(`^${verdict.nextAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (await byLabel.count()) {
        const before = await captureInteractivePageState(applyPage);
        const beforeUrl = applyPage.url();
        const clicked = await byLabel
          .first()
          .click({ timeout: 6_000 })
          .then(() => true)
          .catch(() => false);
        if (clicked) {
          console.log(`  · pressed "${verdict.nextAction}"`);
          await applyPage.waitForURL((url) => url.href !== beforeUrl, { timeout: 12_000 }).catch(() => {});
          await waitForInteractivePageChange(applyPage, before);
          await waitForInteractiveSurface(applyPage, 4_000);
          continue;
        }
      }
    }

    return { status: 'needs-human', jobId: job.id, reason: `stuck: ${verdict.reasoning}`, url: applyPage.url() };
  }

  return { status: 'needs-human', jobId: job.id, reason: `exceeded ${MAX_STEPS} steps`, url: applyPage.url() };
}
