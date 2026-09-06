import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { config } from './config.js';
import {
  captureInteractivePageState,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from './browser.js';
import { extractFields, fillField, pageSummary } from './dom.js';
import { answerFields, classifyPage, coverLetterForJob } from './gemini.js';
import { rewriteLongText } from './humanizer.js';
import { RESUME_DIR, pickResumeForJob, selectResume } from './resume.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

const MAX_STEPS = 14;

/**
 * SEEK pads button labels with invisible formatting characters — the apply CTA
 * literally renders as "Apply⁠" (word joiner). `\s` does not match those,
 * so naive text matching silently fails on every listing.
 */
const clean = (s: string) => s.replace(/[​-‍⁠﻿ ]/g, '').trim();

/**
 * Cheap deterministic checks first — no model call needed.
 *
 * Identity detection has to be conservative: SEEK renders a *non-blocking*
 * "verify with SEEK Pass" upsell next to ordinary work-rights questions, which
 * naive text matching reads as a wall and aborts a perfectly good application.
 * So mentions only count when there is genuinely no way forward.
 */
async function detectFriction(page: Page): Promise<'captcha' | 'identity' | null> {
  const url = page.url();
  if (/seekpass|verify-identity|right-to-work/i.test(url)) return 'identity';

  const hasRecaptcha = await page
    .locator(
      'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], .g-recaptcha, ' +
      'iframe[src*="captcha-delivery"], iframe[title*="Verification system" i]',
    )
    .count()
    .catch(() => 0);
  if (hasRecaptcha > 0) return 'captcha';

  const body = await page.locator('body').innerText().catch(() => '');
  if (/i'?m not a robot|select all (images|squares)|verify you are human/i.test(body)) return 'captcha';

  /**
   * "…to continue applying" is SEEK stating outright that this listing is
   * gated on verified work rights. The Continue button stays *enabled* on such
   * pages — clicking it simply bounces you back — so button state is not a
   * reliable signal here and the wording has to be trusted instead.
   */
  if (/verify your (work rights|identity)[^.]{0,40}to continue/i.test(body)) return 'identity';

  // Otherwise SEEK Pass is usually just an upsell beside an ordinary question,
  // and only counts as a wall when nothing can move the application forward.
  if (/seek pass|verify your (work rights|identity)/i.test(body)) {
    const canProceed = await hasEnabledAdvanceControl(page);
    if (!canProceed) return 'identity';
  }
  return null;
}

/** True when some enabled control still moves the application forward. */
async function hasEnabledAdvanceControl(page: Page): Promise<boolean> {
  const controls = page.locator('button:visible, a[role="button"]:visible');
  const n = Math.min(await controls.count(), 40);
  for (let i = 0; i < n; i++) {
    const text = clean(await controls.nth(i).innerText().catch(() => '')).toLowerCase();
    if (!/(continue|next|submit|review and submit|review your application)/.test(text)) continue;
    if (await controls.nth(i).isEnabled().catch(() => false)) return true;
  }
  return (await deepActionControls(page)).some(
    (control) => !control.disabled && /(continue|next|submit|review and submit|review your application)/i.test(control.text),
  );
}

interface DeepActionControl {
  ref: string;
  text: string;
  disabled: boolean;
}

/** Visible buttons nested inside open web-component shadow roots. */
async function deepActionControls(page: Page): Promise<DeepActionControl[]> {
  return page.evaluate(() => {
    const deepElements = (root: Document | ShadowRoot = document): Element[] => {
      const found = [...root.querySelectorAll('*')];
      for (const element of [...found]) if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
      return found;
    };
    return deepElements()
      .filter((element) => element.tagName === 'BUTTON' || (element.tagName === 'A' && element.getAttribute('role') === 'button'))
      .filter((element) => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(element as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((element, index) => {
        const ref = `a${index}`;
        element.setAttribute('data-bot-action-ref', ref);
        return {
          ref,
          text: (element.textContent ?? '').trim(),
          disabled: (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true',
        };
      });
  });
}

async function clickDeepAction(page: Page, ref: string): Promise<boolean> {
  return page.evaluate((wantedRef) => {
    const deepElements = (root: Document | ShadowRoot = document): Element[] => {
      const found = [...root.querySelectorAll('*')];
      for (const element of [...found]) if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
      return found;
    };
    const target = deepElements().find((element) => element.getAttribute('data-bot-action-ref') === wantedRef);
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }, ref);
}

async function detectConfirmation(page: Page): Promise<boolean> {
  // The URL is the authoritative signal; SEEK lands on /apply/success.
  if (/\/apply\/success/.test(page.url())) return true;

  // SEEK application forms and employer copy can contain phrases such as
  // "application received" before anything has been submitted. On SEEK, only
  // its dedicated success URL is proof of submission.
  if (/(^|\.)seek\.com\.au$/i.test(new URL(page.url()).hostname)) return false;

  // External ATSs do not share a stable success URL. Accept their confirmation
  // copy only after the form and all forward actions have disappeared.
  const body = await page.locator('body').innerText().catch(() => '');
  const confirmationCopy =
    /(application (has been|was) (sent|submitted)|your application was sent|nice work,|thanks for applying|application received)/i.test(
      body,
    );
  if (!confirmationCopy) return false;
  const hasForm = (await page.locator('form input:visible, form textarea:visible, form select:visible').count().catch(() => 0)) > 0;
  return !hasForm && !(await hasEnabledAdvanceControl(page));
}

function isExternal(url: string): boolean {
  if (/\/apply\/external/i.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    return !/(^|\.)seek\.com\.au$|(^|\.)seek\.com$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Controls that can transmit an application.
 *
 * SEEK now uses "Review and submit" as the terminal action on some one-page
 * applications (rather than navigating to a separate `/review` page). Treat
 * every submit-labelled action as terminal so a rehearsal can never click it.
 */
const SUBMIT_LABELS = /^(review and submit|review your application|submit application|submit|send application)$/i;

/**
 * SEEK's design system renders dialogs into `#braid-modal-container`. While one
 * is open it swallows pointer events for the whole page, so a click on the step
 * button underneath retries for the full timeout and then fails — which is
 * exactly what a résumé upload triggers.
 *
 * Returns true if something was dismissed, so the caller can retry its click.
 */
async function dismissBlockingModal(page: Page): Promise<boolean> {
  const modal = page.locator('#braid-modal-container');
  if (!(await modal.count())) return false;
  const visible = await modal.locator(':scope > *').first().isVisible().catch(() => false);
  if (!visible) return false;

  // Prefer an explicit acknowledgement over a bare close where one exists.
  const buttons = modal.locator('button:visible');
  const n = Math.min(await buttons.count(), 12);
  for (const want of [/^(done|save|confirm|ok|got it|continue)$/i, /^(close|cancel|dismiss)$/i]) {
    for (let i = 0; i < n; i++) {
      const text = clean(await buttons.nth(i).innerText().catch(() => ''));
      const aria = clean((await buttons.nth(i).getAttribute('aria-label').catch(() => '')) ?? '');
      if (!want.test(text) && !want.test(aria)) continue;
      await buttons.nth(i).click({ timeout: 5_000 }).catch(() => {});
      await jitter(700, 1400);
      return true;
    }
  }

  // Nothing recognisable inside it — Escape closes braid dialogs.
  await page.keyboard.press('Escape').catch(() => {});
  await jitter(500, 1000);
  return !(await modal.locator(':scope > *').first().isVisible().catch(() => false));
}

/**
 * Finds the button that advances the flow.
 *
 * Returns 'submit-withheld' in dry-run when the only way forward is the final
 * submit — so a rehearsal exercises every step (including cover letter and
 * screening answers) without an application actually reaching an employer.
 */
async function clickAdvance(
  page: Page,
  preferredLabel?: string | null,
  protectExternalSubmit = false,
): Promise<'advanced' | 'submit-withheld' | 'none'> {
  /**
   * "Choose documents", "Update SEEK Profile" and "Review and submit" are
   * persistent sidebar nav — they render on *every* step. On the review page
   * that means "Review and submit" shadows the real "Submit application" and
   * the flow spins in place, so once we are on /review the terminal submit
   * has to be tried first.
   */
  const onReview = /\/apply\/review/.test(page.url());
  const labels = onReview
    ? [
        ...(preferredLabel ? [preferredLabel] : []),
        'Submit application',
        'Submit',
        'Continue',
      ]
    : [
        ...(preferredLabel ? [preferredLabel] : []),
        'Continue',
        'Next',
        'Review and submit',
        'Review your application',
        'Submit application',
        'Submit',
      ];
  // Match on cleaned text rather than an anchored regex: SEEK's labels carry
  // invisible padding characters that defeat `^...$` matching.
  const controls = page.locator('button:visible, a[role="button"]:visible');
  const n = await controls.count();
  const seen: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < n; i++) {
    const text = clean(await controls.nth(i).innerText().catch(() => ''));
    if (text) seen.push({ idx: i, text });
  }
  const deepSeen = await deepActionControls(page);

  for (const label of labels) {
    const want = clean(label).toLowerCase();
    const hit = seen.find((s) => s.text.toLowerCase() === want);
    const deepHit = deepSeen.find((control) => clean(control.text).toLowerCase() === want);
    if (!hit && !deepHit) continue;
    const btn = hit ? controls.nth(hit.idx) : null;
    if (btn && !(await btn.isEnabled().catch(() => false))) continue;
    if (!btn && deepHit?.disabled) continue;
    const looksLikeExternalSubmit = /^(apply|apply now|finish|finish application|complete application)$/i.test(want);
    if (config.dryRun && (SUBMIT_LABELS.test(want) || (protectExternalSubmit && looksLikeExternalSubmit))) {
      return 'submit-withheld';
    }

    // Fail fast rather than retrying for the default 30s: an intercepted click
    // almost always means a dialog is open, which is fixable.
    const before = await captureInteractivePageState(page);
    let clicked = btn
      ? await btn.click({ timeout: 6_000 }).then(() => true).catch(() => false)
      : deepHit ? await clickDeepAction(page, deepHit.ref) : false;

    if (!clicked && btn && (await dismissBlockingModal(page))) {
      console.log('  ↳ cleared a dialog blocking the page, retrying');
      clicked = await btn
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) continue;

    await waitForInteractivePageChange(page, before);
    await waitForInteractiveSurface(page, 4_000);
    return 'advanced';
  }
  return 'none';
}

/** Opens a SEEK Apply CTA whether the employer flow replaces the tab or opens a new one. */
async function openApplyFlow(page: Page, applyCta: Locator): Promise<Page> {
  const href = await applyCta.getAttribute('href').catch(() => null);
  if (href) {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' });
    await waitForInteractiveSurface(page);
    return page;
  }
  const popup = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);
  await applyCta.click();
  const opened = await popup;
  const target = opened ?? page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForInteractiveSurface(target);
  return target;
}

type ExternalResumeOutcome =
  | { status: 'none' }
  | { status: 'uploaded'; name: string }
  | { status: 'unavailable'; reason: string };

/** Uploads the selected résumé when a supported external form asks for one. */
async function maybeUploadExternalResume(page: Page, job: JobListing, profile: CandidateProfile): Promise<ExternalResumeOutcome> {
  const all = page.locator('input[type="file"]');
  const count = await all.count();
  if (!count) return { status: 'none' };

  let chosen: Locator | null = null;
  const documentInputs: Locator[] = [];
  for (let index = 0; index < count; index++) {
    const input = all.nth(index);
    const description = await input
      .evaluate((el) => {
        const id = el.getAttribute('id');
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const precedingHeading = [...document.querySelectorAll('h1, h2, h3, h4, legend')]
          .filter((heading) => Boolean(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
          .at(-1)?.textContent;
        return {
          semantic: [
          el.getAttribute('name'),
          el.getAttribute('aria-label'),
          label?.textContent,
          precedingHeading,
          el.closest('fieldset, section')?.querySelector('legend, h2, h3, strong')?.textContent,
          ].filter(Boolean).join(' '),
          accept: el.getAttribute('accept') ?? '',
        };
      })
      .catch(() => ({ semantic: '', accept: '' }));
    if (/r[eé]sum[eé]|curriculum vitae|\bcv\b/i.test(description.semantic)) {
      chosen = input;
      break;
    }
    if (/\.pdf|\.docx?|\.rtf/i.test(description.accept)) documentInputs.push(input);
  }
  // SmartRecruiters exposes both an optional résumé-autofill upload near the
  // top and the required résumé attachment later in the form. Prefer the last
  // document input when semantic labelling is unavailable so the required
  // attachment is satisfied rather than guessing at an image upload.
  if (!chosen && documentInputs.length) chosen = documentInputs.at(-1) ?? null;
  if (!chosen) return { status: 'none' };

  const alreadyAttached = await chosen.inputValue().catch(() => '');
  if (alreadyAttached) return { status: 'uploaded', name: alreadyAttached.replace(/^.*[\\/]/, '') };

  const wanted = await pickResumeForJob(job, profile);
  if (!wanted) return { status: 'unavailable', reason: 'no résumé is selected for this run' };
  const localPath = resolve(RESUME_DIR, wanted.fileName);
  if (!existsSync(localPath)) {
    return { status: 'unavailable', reason: `selected résumé file is missing: ${wanted.fileName}` };
  }

  try {
    await chosen.setInputFiles(localPath, { timeout: 15_000 });
    return { status: 'uploaded', name: wanted.fileName };
  } catch (error) {
    return { status: 'unavailable', reason: `résumé upload failed: ${(error as Error).message}` };
  }
}

/** Handles the optional cover-letter step, which is a textarea behind a radio. */
type PrefetchedLetter = Promise<{ letter?: string; error?: Error }>;

async function maybeCoverLetter(
  page: Page,
  job: JobListing,
  profile: CandidateProfile,
  prefetched?: PrefetchedLetter,
): Promise<string | undefined> {
  const body = await page.locator('body').innerText().catch(() => '');
  if (!/cover letter/i.test(body)) return undefined;

  const writeOption = page
    .getByRole('radio', { name: /write a cover letter|add a cover letter/i })
    .first();
  if (await writeOption.count()) await writeOption.check({ force: true }).catch(() => {});

  const textarea = page.locator('textarea:visible').first();
  // The box is in the DOM but hidden until the radio is chosen, so `count()`
  // alone is not enough — wait for it to actually be editable, and if it never
  // is, fall through and let the generic field-answering path handle it.
  try {
    await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    return undefined;
  }

  /**
   * Always regenerate — never keep what is already in the box.
   *
   * SEEK persists the last cover letter you typed and pre-fills it into the
   * next application. Trusting it means addressing one employer by another
   * employer's name; a rehearsal here surfaced a draft for "AI Fullstack
   * Engineer at Robert Walters" sitting in a Talent application.
   */
  const existing = await textarea.inputValue().catch(() => '');
  if (existing.trim().length > 40 && !existing.toLowerCase().includes(job.company.toLowerCase())) {
    console.warn(`  ! discarded a stale pre-filled cover letter (not addressed to ${job.company})`);
  }

  const draft = prefetched
    ? await prefetched
    : { letter: await coverLetterForJob(job, profile) };
  if (draft.error) throw draft.error;
  if (!draft.letter) throw new Error('Cover-letter drafting returned no text.');
  const letter = draft.letter;
  try {
    await textarea.fill(letter, { timeout: 8_000 });
  } catch {
    return undefined; // generic field handling will cover it
  }
  if (config.coverLetter.mode === 'reuse') console.log('  ↻ reusable cover letter selected');
  return letter;
}

export interface ApplyDeps {
  onFriction: (kind: 'captcha' | 'identity') => void;
}

/**
 * Drives one application end to end.
 *
 * Stops and returns `needs-human` rather than attempting to get past a CAPTCHA
 * or identity wall, and rather than submitting any answer the model could not
 * ground in the candidate profile.
 */
export async function applyToJob(
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
        /you applied|already applied/i.test(document.body.innerText),
      { timeout: 10_000 },
    )
    .catch(() => {});

  const alreadyApplied = await page
    .locator('text=/you applied|already applied/i')
    .count()
    .catch(() => 0);
  if (alreadyApplied > 0) return { status: 'skipped', jobId: job.id, reason: 'SEEK reports already applied' };

  /**
   * The CTA is always `[data-automation="job-detail-apply"]`; its label is what
   * distinguishes the flows. "Quick apply" is hosted by SEEK; a bare "Apply"
   * hands off to the employer's own ATS, so we stop there without navigating.
   */
  const applyCta = page.locator('[data-automation="job-detail-apply"]').first();
  if (!(await applyCta.count())) {
    return { status: 'skipped', jobId: job.id, reason: 'no apply control found (expired?)' };
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
    return { status: 'skipped', jobId: job.id, reason: 'DRY_RUN (set REHEARSE=true to fill forms)' };
  }

  // Draft while the application UI opens and renders. The exact same draft is
  // used later; this only overlaps independent browser and model work.
  const prefetchedLetter: PrefetchedLetter = coverLetterForJob(job, profile).then(
    (letter) => ({ letter }),
    (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );
  page = await openApplyFlow(page, applyCta);

  // Everything the run would send, captured so a dry run can show it.
  const captured: Array<{ question: string; answer: string }> = [];
  let coverLetter: string | undefined;
  let resumeDone = false;
  let resumeUsed: string | undefined;
  let lastUrl = '';
  let stagnant = 0;
  let externalFlow = externalCta;

  for (let step = 0; step < MAX_STEPS; step++) {
    // A click that changes nothing means we matched a nav element, not the
    // step's real control. Escalate rather than burning the step budget.
    if (page.url() === lastUrl) {
      if (++stagnant >= 2) {
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: `stuck on the same step (${page.url()}) — no control advanced the flow`,
          url: page.url(),
        };
      }
    } else {
      stagnant = 0;
    }
    lastUrl = page.url();

    // Client-rendered ATS pages often finish loading well after
    // domcontentloaded. Wait for a real form control before concluding that
    // the page has no answerable fields.
    if (step === 0 && (externalFlow || isExternal(page.url()))) {
      await page
        .locator('input:visible, textarea:visible, select:visible')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {});
    }

    if (process.env.DEBUG_STEPS === 'true') {
      const labels = await page
        .locator('button:visible')
        .allInnerTexts()
        .catch(() => [] as string[]);
      const deepLabels = (await deepActionControls(page)).map((control) => control.text);
      console.log(
        `    step ${step}: ${page.url().replace('https://au.seek.com', '')} ` +
          `buttons=[${[...new Set([...labels, ...deepLabels].map(clean))].filter(Boolean).slice(0, 8).join(' | ')}]`,
      );
    }

    if (isExternal(page.url())) {
      if (!config.allowExternalApply) {
        return { status: 'off-platform', jobId: job.id, redirectedTo: page.url() };
      }
      if (!externalFlow) console.log(`  ↗ continuing on supported external site: ${new URL(page.url()).hostname}`);
      externalFlow = true;
    }

    /**
     * Success is checked FIRST, deliberately. SEEK renders a "verify your work
     * rights with SEEK Pass" upsell on the confirmation page, which the
     * friction detector reads as a wall — reporting a submitted application as
     * `needs-human`, leaving it unrecorded, and setting up a duplicate
     * application on the next run.
     */
    if (await detectConfirmation(page)) {
      return {
        status: 'applied',
        jobId: job.id,
        at: new Date().toISOString(),
        coverLetter,
        answers: captured,
      };
    }

    const friction = await detectFriction(page);
    if (friction) {
      deps.onFriction(friction);
      return {
        status: 'needs-human',
        jobId: job.id,
        reason: friction === 'captcha' ? 'CAPTCHA challenge' : 'identity / work-rights verification',
        url: page.url(),
      };
    }

    // Résumé choice happens before the generic field pass, so the model never
    // has to guess which document to attach.
    if (externalFlow && !resumeDone) {
      const externalResume = await maybeUploadExternalResume(page, job, profile);
      if (externalResume.status === 'unavailable') {
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: externalResume.reason,
          url: page.url(),
        };
      }
      if (externalResume.status === 'uploaded') {
        resumeDone = true;
        resumeUsed = externalResume.name;
        captured.push({ question: 'Résumé', answer: externalResume.name });
        console.log(`  📄 external résumé: ${externalResume.name}`);
      }
    }

    if (!resumeDone && (await page.locator('input[name="document-select"]').count())) {
      const wanted = await pickResumeForJob(job, profile);
      const outcome = await selectResume(page, wanted, config.resume.allowUpload);
      resumeDone = true;
      resumeUsed = 'name' in outcome ? outcome.name : undefined;

      if (outcome.status === 'unavailable') {
        return {
          status: 'needs-human',
          jobId: job.id,
          reason:
            `résumé "${outcome.wanted}" is not on your SEEK profile. ` +
            `Available: ${outcome.available.join(', ') || 'none'}. ` +
            `Upload it to SEEK, or enable "allow upload" to have the bot add it.`,
          url: page.url(),
        };
      }
      if (outcome.status === 'uploaded') {
        console.log(`  ↑ uploaded résumé "${outcome.name}" to your SEEK profile`);
      } else if (outcome.status === 'selected') {
        console.log(`  📄 résumé: ${outcome.name}`);
      }
      captured.push({ question: 'Résumé', answer: resumeUsed ?? 'default' });
    }

    coverLetter = (await maybeCoverLetter(page, job, profile, prefetchedLetter)) ?? coverLetter;

    const fields = await extractFields(page);
    const answerable = fields.filter(
      (f) =>
        /**
         * Fields already decided deterministically, above, must not be handed
         * to the model as well — it answers them a second time and overwrites
         * the correct value. Every one of these was observed in a rehearsal:
         *
         *  - the cover-letter textarea, already filled by `maybeCoverLetter`
         *    with a grounded, fact-checked letter, was overwritten by a second
         *    unvalidated draft that invented a university the candidate never
         *    attended;
         *  - `coverLetter-method`, the radio that decides whether a letter is
         *    attached at all, was flipped to "Don't include a cover letter" —
         *    so a correct letter was written and then silently discarded;
         *  - `document-select`, the résumé radio already set by
         *    `selectResume`, was switched to a different document than the one
         *    chosen for this job, and on another listing was declared
         *    "not answerable from profile" and stopped the application.
         *
         * The hyphen-less `coverLetter-method` is why this matches
         * `cover.?letter` rather than a literal "cover letter".
         */
        !/cover.?letter/i.test(f.label) &&
        !/document.?select/i.test(f.label) &&
        (f.kind !== 'checkbox' || /agree|consent|privacy|terms|declare/i.test(f.label)),
    );

    if (answerable.length) {
      const { answers, injectionSuspected } = await answerFields(answerable, job, profile);
      if (injectionSuspected) {
        console.warn(`  ! injection-shaped text in ${job.company} — ignored, continuing`);
      }

      const ungrounded = answers.filter((a) => !a.grounded);
      if (ungrounded.length) {
        const byRef = new Map(fields.map((f) => [f.ref, f]));
        const detail = ungrounded
          .map((a) => `"${byRef.get(a.ref)?.label ?? a.ref}"${a.rationale ? ` (${a.rationale})` : ''}`)
          .join('; ');
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: `question not answerable from profile: ${detail}`,
          url: page.url(),
        };
      }

      for (const a of answers) {
        const field = fields.find((f) => f.ref === a.ref);
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
              url: page.url(),
            };
          }
        }
        try {
          await fillField(page, field, value);
          captured.push({ question: field.label, answer: value });
        } catch (err) {
          console.warn(`  ! could not fill "${field.label}": ${(err as Error).message}`);
        }
      }

      const formFriction = await detectFriction(page);
      if (formFriction) {
        deps.onFriction(formFriction);
        return {
          status: 'needs-human',
          jobId: job.id,
          reason: formFriction === 'captcha' ? 'CAPTCHA challenge' : 'identity / work-rights verification',
          url: page.url(),
        };
      }
    }

    const advanced = await clickAdvance(page, undefined, externalFlow && captured.length > 0);
    if (advanced === 'submit-withheld') {
      return {
        status: 'rehearsed',
        jobId: job.id,
        coverLetter,
        answers: captured,
        stoppedAt: page.url(),
      };
    }
    if (advanced === 'advanced') continue;

    // Nothing recognised — let Gemini look at the page.
    const verdict = await classifyPage(await pageSummary(page));
    console.log(`  [assist] page looks like: ${verdict.kind} — ${verdict.reasoning}`);

    if (verdict.kind === 'confirmation') {
      return {
        status: 'applied',
        jobId: job.id,
        at: new Date().toISOString(),
        coverLetter,
        answers: captured,
      };
    }
    if (verdict.kind === 'external-redirect') {
      if (!config.allowExternalApply) {
        return { status: 'off-platform', jobId: job.id, redirectedTo: page.url() };
      }
      externalFlow = true;
    }
    if (verdict.humanNeeded) {
      if (verdict.kind === 'captcha' || verdict.kind === 'identity-verification') {
        deps.onFriction(verdict.kind === 'captcha' ? 'captcha' : 'identity');
      }
      return { status: 'needs-human', jobId: job.id, reason: verdict.reasoning, url: page.url() };
    }
    /**
     * Bounced back to the listing page after the flow had started. SEEK does
     * this when a step is rejected — most often an unverified work-rights
     * requirement. "Stuck on a job listing" is a confusing thing to report, so
     * name the likely cause instead.
     */
    if (/\/job\/\d+(\?|$)/.test(page.url()) && step > 0) {
      return {
        status: 'needs-human',
        jobId: job.id,
        reason:
          'SEEK returned to the job listing mid-application — the apply step was rejected. ' +
          'This listing most likely requires verified work rights (SEEK Pass) before it will continue.',
        url: page.url(),
      };
    }

    if (verdict.nextAction) {
      const r = await clickAdvance(page, verdict.nextAction, externalFlow && captured.length > 0);
      if (r === 'submit-withheld') {
        return {
          status: 'rehearsed',
          jobId: job.id,
          coverLetter,
          answers: captured,
          stoppedAt: page.url(),
        };
      }
      if (r === 'advanced') continue;
    }

    return { status: 'needs-human', jobId: job.id, reason: `stuck: ${verdict.reasoning}`, url: page.url() };
  }

  return { status: 'needs-human', jobId: job.id, reason: `exceeded ${MAX_STEPS} steps`, url: page.url() };
}
