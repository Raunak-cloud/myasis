import type { Page } from 'patchright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import {
  captureInteractivePageState,
  hasVisibleCaptcha,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from './browser.js';
import { extractFields, fillField, pageSummary } from './dom.js';
import { answerFields, classifyPage, coverLetterForJob } from './llm.js';
import { rewriteLongText } from './humanizer.js';
import { RESUME_DIR, pickResumeForJob } from './resume.js';
import type { ApplyDeps } from './agent/apply-agent.js';
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

async function detectFriction(page: Page): Promise<'captcha' | null> {
  return await hasVisibleCaptcha(page) ? 'captcha' : null;
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
const SUBMIT_LABEL = /^submit your application$/i;
const CONTINUE_LABEL = /^continue$/i;

async function clickContinueOrSubmit(page: Page): Promise<'advanced' | 'submit-withheld' | 'none'> {
  const onReview = /\/beta\/indeedapply\/form\/review-module/.test(page.url());
  const submitBtn = byName(page, SUBMIT_LABEL);
  if (onReview && (await submitBtn.count())) {
    if (config.dryRun) return 'submit-withheld';
    const before = await captureInteractivePageState(page);
    const clicked = await submitBtn
      .first()
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await waitForInteractivePageChange(page, before);
      await waitForInteractiveSurface(page, 4_000);
      return 'advanced';
    }
  }

  const continueBtn = byName(page, CONTINUE_LABEL);
  if (await continueBtn.count()) {
    const enabled = await continueBtn.first().isEnabled().catch(() => false);
    if (enabled) {
      const before = await captureInteractivePageState(page);
      const clicked = await continueBtn
        .first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        await waitForInteractivePageChange(page, before);
        await waitForInteractiveSurface(page, 4_000);
        return 'advanced';
      }
    }
  }
  return 'none';
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

/** Opens the "Apply with Indeed" flow, which always opens a NEW TAB — verified live twice. */
async function openApplyFlow(page: Page, applyCta: ReturnType<typeof byName>): Promise<Page> {
  const popupPromise = page.context().waitForEvent('page', { timeout: 8_000 }).catch(() => null);
  await applyCta.first().click();
  const popup = await popupPromise;
  const target = popup ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForInteractiveSurface(target);
  return target;
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
  if (!wanted) return { status: 'kept-default' };

  const radios = page.locator('input[type=radio]');
  const count = await radios.count();
  const needles = [wanted.label, wanted.fileName]
    .map((s) => s.toLowerCase().replace(/\.(pdf|docx?|rtf)$/i, '').trim())
    .filter(Boolean);
  for (let i = 0; i < count; i++) {
    const label = clean(
      await radios
        .nth(i)
        .evaluate((el) => (el.closest('label')?.textContent ?? '') || '')
        .catch(() => ''),
    ).toLowerCase();
    if (needles.some((needle) => label.includes(needle))) {
      await radios.nth(i).click({ force: true }).catch(() => {});
      return { status: 'selected' };
    }
  }
  // Uploading a new résumé via Indeed's "Resume options" picker was not
  // exercised live, so this deliberately does not attempt it — see the
  // needs-human path in applyToIndeedJob. The two cases differ only in what
  // the human needs to do next: fetch a missing file, or just upload the one
  // already sitting in data/resumes/.
  const localPath = resolve(RESUME_DIR, wanted.fileName);
  return existsSync(localPath)
    ? { status: 'unavailable', wanted: wanted.label, detail: 'not yet uploaded to Indeed' }
    : { status: 'unavailable', wanted: wanted.label, detail: `local file data/resumes/${wanted.fileName} is missing too` };
}

async function detectConfirmation(page: Page): Promise<boolean> {
  if (/\/beta\/indeedapply\/form\//.test(page.url())) return false; // still inside the wizard
  const body = await page.locator('body').innerText().catch(() => '');
  return /application (has been |was )?(submitted|sent)|you'?ve applied|successfully applied|application received/i.test(
    body,
  );
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

  const indeedApplyCta = byName(page, /^apply with indeed/i);
  const externalCta = byName(page, /^apply on company site/i);
  if (!(await indeedApplyCta.count())) {
    if (await externalCta.count()) {
      const label = clean((await externalCta.first().innerText().catch(() => '')) || 'Apply on company site');
      return { status: 'off-platform', jobId: job.id, redirectedTo: `${label} → ${job.url}` };
    }
    return { status: 'skipped', jobId: job.id, reason: 'no apply control found (expired?)' };
  }

  if (config.dryRun && process.env.REHEARSE !== 'true') {
    return { status: 'skipped', jobId: job.id, reason: 'DRY_RUN (set REHEARSE=true to fill forms)' };
  }

  const prefetchedLetter: Promise<{ letter?: string; error?: Error }> = coverLetterForJob(job, profile).then(
    (letter) => ({ letter }),
    (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );
  const applyPage = await openApplyFlow(page, indeedApplyCta);
  try {
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
  let stagnant = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (applyPage.url() === lastUrl) {
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

    if (await detectConfirmation(applyPage)) {
      return { status: 'applied', jobId: job.id, at: new Date().toISOString(), coverLetter, answers: captured };
    }

    const friction = await detectFriction(applyPage);
    if (friction) {
      deps.onFriction(friction);
      return {
        status: 'needs-human',
        jobId: job.id,
        reason: 'CAPTCHA / verification challenge',
        url: applyPage.url(),
      };
    }

    if (/\/beta\/indeedapply\/form\/resume-selection-module\//.test(applyPage.url())) {
      const outcome = await handleResumeStep(applyPage, job, profile);
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
          console.warn(`  ! could not fill cover letter: ${(err as Error).message}`);
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

        for (const a of answers) {
          const field = answerable.find((f) => f.ref === a.ref);
          if (!field) continue;
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
            await fillField(applyPage, field, value);
            captured.push({ question: field.label, answer: value });
          } catch (err) {
            console.warn(`  ! could not fill "${field.label}": ${(err as Error).message}`);
          }
        }

        const formFriction = await detectFriction(applyPage);
        if (formFriction) {
          deps.onFriction(formFriction);
          return {
            status: 'needs-human',
            jobId: job.id,
            reason: 'CAPTCHA / verification challenge',
            url: applyPage.url(),
          };
        }
      }
    }

    const advanced = await clickContinueOrSubmit(applyPage);
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
        const clicked = await byLabel
          .first()
          .click({ timeout: 6_000 })
          .then(() => true)
          .catch(() => false);
        if (clicked) {
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
