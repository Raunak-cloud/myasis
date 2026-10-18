import type { Frame, Page } from 'patchright';
import { config } from '../../config.js';
import { waitForPageToSettle } from '../../browser.js';
import { extractFields } from '../../dom.js';
import { answerFields, auditFormBeforeSubmit, isSubmitControl, reviewSavedApplicationForm, verifySubmissionEvidence } from '../../llm.js';
import { pickResumeForJob } from '../../resume.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { FormField } from '../../types.js';
import type { PageChanges } from '../page-changes.js';
import { isEntryAction } from '../guards.js';
import { wasHumanized } from '../../humanizer.js';
import { offersCoverLetter } from '../cover-letter-opportunity.js';
import { boardOf, ensureChosenResume, reopenIndeedResumeStep } from '../../resume-sync.js';
import { boardFullOutcome, settleResume } from './resume-step.js';
import { ToolResult, ToolContext, ok, abandoned } from './context.js';
import { readSavedForm, savedFormSignature } from '../saved-form.js';
import { authorizeReservedSubmission } from '../../application-reservations.js';
import { applicationModelIdentity } from '../../application-model.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

const advancesApplication = (text: string): boolean =>
  /^(continue|next|review(?: your)? application|preview application|save and continue)$/i.test(text.trim());

/**
 * The one fixed rule left about submits, and only a safety net: once anything
 * has been entered, a control that says it applies, submits or sends goes
 * through the submit gates whatever the agent judged. Wrongly applied it
 * costs a check; wrongly missed, an unchecked application goes out (Nestlé,
 * 4 Oct). Every other submit decision is the agent's own.
 */
function submitWorded(ctx: ToolContext, label: string): boolean {
  return Boolean(ctx.captured.length || ctx.resumeUsed || ctx.coverLetter)
    // "Review and submit" is SEEK's terminal action on some one-page applications.
    && /^(apply|apply now|submit|send|send application|finish|complete|complete application|confirm|confirm and submit|review and submit)\b/i.test(label.trim());
}

/** A press that moves the application on: a forward step, or one the agent or the safety net calls the submit. */
const movesForward = (ctx: ToolContext, label: string): boolean =>
  advancesApplication(label) || ctx.declaredSubmit === true || submitWorded(ctx, label);

/**
 * What the page shows after a submit, for the independent verifier.
 *
 * The observation's text is the start of the main region, capped for the
 * agent's prompt; an employer that prints "Your application has been
 * submitted" under a long job ad and the form was outside it, so a real
 * submission read as unconfirmed and the agent pressed Submit again. The
 * verifier gets the whole page's beginning and end instead.
 */
export async function submissionEvidence(ctx: ToolContext): Promise<{ url: string; text: string; actions: unknown[]; fields: unknown[] }> {
  const body = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => ctx.observation.text);
  const text = body.length > 12_000 ? `${body.slice(0, 3_000)}\n…\n${body.slice(-9_000)}` : body;
  return { url: ctx.page.url(), text, actions: ctx.observation.actions, fields: ctx.observation.fields };
}

const submitVerdicts = new Map<string, boolean>();

/**
 * Whether pressing a control sends the application — the question every
 * submit gate hangs on. The label list catches the common wordings for free;
 * anything else on a form with something to send is read by the model, per
 * page and label. A failed check counts as a submit: it can only hold a click
 * back for the gates, never let one through unguarded.
 */
async function transmits(ctx: ToolContext, label: string, context?: string): Promise<boolean> {
  if (isEntryAction(label, { captured: ctx.captured.length, fields: ctx.observation.fields.length })) return false;
  if (!label.trim() || /\(opens a list\)$/.test(label)) return false;
  if (submitWorded(ctx, label)) return true;
  /**
   * The agent's own judgement, given with the press, decides; the backstop
   * above still makes a submit-worded control on a filled form a submit. A
   * separate model is asked only when the agent did not say.
   */
  if (typeof ctx.declaredSubmit === 'boolean') {
    if (ctx.declaredSubmit) ctx.log(`  · "${label.slice(0, 60)}" is the final submit (the agent's judgement)`);
    return ctx.declaredSubmit;
  }
  // Nothing typed, attached or on the page: there is nothing a click could send.
  if (!ctx.captured.length && !ctx.resumeUsed && !ctx.coverLetter && !ctx.observation.fields.length) return false;
  /**
   * A verdict holds for the form as it was when it was given. Keyed by page
   * and label alone, SuccessFactors' "Apply" (one address for the whole
   * flow) was judged at the start, before anything was entered, as opening
   * the form; the same verdict was reused once the form was complete, and
   * the final submit was pressed with no audit, and during a rehearsal.
   */
  const control = { label, context };
  const page = { url: ctx.page.url(), title: ctx.observation.title, text: ctx.observation.text,
    fields: ctx.observation.fields.length, entered: ctx.captured.length };
  // Reuse only the exact classifier input. Equal captions/counts can belong
  // to a privacy dialog and a later final-review form on the same address.
  const key = createHash('sha256').update(JSON.stringify({ control, page })).digest('hex');
  const known = submitVerdicts.get(key);
  if (known !== undefined) return known;
  const verdict = await isSubmitControl(control, page).catch(() => true);
  submitVerdicts.set(key, verdict);
  if (verdict) ctx.log(`  · "${label.slice(0, 60)}" read as the final submit`);
  return verdict;
}

type Gate = { proceed: true; submit: boolean } | { proceed: false; result: ToolResult };
type PressOptions = { role?: string; knownSubmit?: boolean };

async function classifyPress(ctx: ToolContext, label: string, context: string | undefined, options: PressOptions) {
  const entry = !options.knownSubmit && isEntryAction(label, { captured: ctx.captured.length, fields: ctx.observation.fields.length });
  if (entry) ctx.log(`  → opening the application: "${label}"`);
  const submit = options.knownSubmit === true
    || (!entry && options.role !== 'toggle' && options.role !== 'file' && await transmits(ctx, label, context));
  ctx.pressJudged = true;
  return { entry, submit };
}

/**
 * The checks every press of a control passes, whichever tool presses it — a
 * listed action, a point on the screenshot, a snapshot element, the Enter key,
 * a script, or a form post caught on the network. One gate, so a new way to
 * act cannot become a new way around the rules:
 *
 * - a cover letter the employer offers is written before the form advances;
 * - a forward/submit control checks the current saved form once;
 * - a submit passes configuration policy (dry run and external scope);
 * - a second submit is pressed only once the first is known not to have gone
 *   through, since some forms confirm in place and pressing again sends the
 *   employer another copy;
 * - a form the agent filled with its own browser tools is audited first.
 */
export async function gateAdvance(
  ctx: ToolContext,
  label: string,
  context?: string,
  options: PressOptions = {},
): Promise<Gate> {
  // A call already abandoned for taking too long may not press anything: the agent has moved on without it.
  if (abandoned()) {
    ctx.log(`  · held "${label.slice(0, 60)}": it came from a step already abandoned`);
    return { proceed: false, result: ok('This step was abandoned for taking too long; nothing was pressed.') };
  }
  /**
   * The observation's text is the start of the page, capped. Indeed's review
   * page puts "Supporting documents" under the resume preview, past that cap,
   * so a letter the employer allowed could go unsent. Before the form moves
   * on without a letter, the whole page is read for a place to add one.
   */
  /**
   * The resume a board sends is Owtomate's, never whatever it preselected.
   * Settled here, deterministically, as the documents step is left, so the
   * agent cannot move past it with the board's own copy (src/resume-sync.ts).
   */
  /**
   * Nothing saved on the person's job-board account is deleted: their
   * resumés, cover letters and profile are theirs. On 5 Oct the agent deleted
   * documents from a SEEK profile to make room for an upload.
   */
  // The control's own words only: nearby copy such as "you can remove this later" must not hold a Continue.
  if (boardOf(ctx.page.url()) && /^\W*(delete|remove|discard)\b/i.test(label.trim())) {
    ctx.log(`  ⛔ held "${label.slice(0, 60)}": nothing on the person's ${boardOf(ctx.page.url()) === 'seek' ? 'SEEK' : 'Indeed'} account is deleted`);
    return { proceed: false, result: ok('Not allowed: nothing saved on the person\'s job-board account (resumés, cover letters, profile) may be deleted or removed. If the board says its document limit is reached, finish with needs_human and say so.') };
  }
  if (movesForward(ctx, label) && !ctx.resumeSettled) {
    const chosen = await pickResumeForJob(ctx.job, ctx.profile);
    const step = chosen ? await ensureChosenResume(ctx.page, chosen) : { action: 'none' as const };
    if (step.action === 'failed' && step.full) return { proceed: false, result: boardFullOutcome(step) };
    if (step.action === 'failed') {
      return { proceed: false, result: ok(
        `Do not advance yet: the resume must be Owtomate's "${chosen!.seekName || chosen!.fileName}", not one the board preselected. ${step.reason} ` +
        'Select its exact option with attach_resume, or upload it with attach_resume on the upload control, then press again.',
      ) };
    }
    if (step.action !== 'none') settleResume(ctx, step);
  }
  const { entry, submit } = await classifyPress(ctx, label, context, options);
  if (!entry) {
    // Asked at the press the agent itself calls the final submit; a press a word list calls a submit
    // but the agent does not (Indeed's "Review your application") still runs the submit gates below.
    const final = ctx.declaredSubmit ?? submit;
    const letter = await coverLetterCheck(ctx, label, final);
    if (letter) return { proceed: false, result: letter };
  }
  if (!submit) {
    if (!entry && movesForward(ctx, label)) {
      const held = await checkSavedForm(ctx);
      if (held) return { proceed: false, result: held };
    }
    return { proceed: true, submit: false };
  }

  /**
   * Indeed can open an application straight on its review page with the
   * resume it already holds for the account attached, so no resume step ever
   * came up for the check above. Nothing is submitted on Indeed until the
   * resume is known to be Owtomate's: the resume step is reopened and settled,
   * and the agent goes through to the review page again.
   */
  if (!ctx.resumeSettled && !ctx.resumeUsed && boardOf(ctx.page.url()) === 'indeed') {
    const chosen = await pickResumeForJob(ctx.job, ctx.profile);
    if (chosen) {
      ctx.resumeReopenTries = (ctx.resumeReopenTries ?? 0) + 1;
      if (ctx.resumeReopenTries > 2) {
        return { proceed: false, result: { kind: 'terminal', outcome: {
          status: 'needs-human',
          reason: 'Indeed attached a resume Owtomate could not replace with the one chosen for this job, so nothing was sent.',
          detail: 'resume step could not be reopened from the review page',
        } } };
      }
      ctx.log('  ↺ Indeed went straight to review with its own saved resume attached; reopening the resume step');
      const step = await reopenIndeedResumeStep(ctx.page, chosen);
      if (step.action === 'failed' && step.full) return { proceed: false, result: boardFullOutcome(step) };
      if (step.action === 'kept' || step.action === 'selected' || step.action === 'uploaded') {
        settleResume(ctx, step);
        return { proceed: false, result: ok(
          `Not submitted yet: Indeed had skipped its resume step and attached the resume it already held. The resume step is now open and Owtomate's "${step.name}" is selected. ` +
          'Continue through the form (answer anything it asks again) to the review page, then submit.',
        ) };
      }
      return { proceed: false, result: ok(
        `Not submitted: the resume Indeed attached is not confirmed as Owtomate's "${chosen.seekName || chosen.fileName}". ` +
        (step.action === 'failed' ? `${step.reason} ` : 'The resume step could not be opened automatically. ') +
        'Open the resume step from the review page (the edit or change control of its resume section), select that resume with attach_resume, continue to review and submit again.',
      ) };
    }
  }

  return authorizeFinalSubmission(ctx, label);
}

/** A final send retains the current form review, dry run, external-access
 * policy, actual sent-value recording and independent receipt checks. */
async function authorizeFinalSubmission(ctx: ToolContext, label: string): Promise<Gate> {
  if (ctx.submissionAttempted) {
    if (await verifySubmissionEvidence(await submissionEvidence(ctx), ctx.job).catch(() => false)) {
      return { proceed: false, result: { kind: 'terminal', outcome: { status: 'applied' } } };
    }
  }
  const verdict = ctx.guards.canSubmit(ctx.page.url());
  if (!verdict.allowed && verdict.kind !== 'dry-run') {
    if (verdict.kind === 'off-platform') {
      return { proceed: false, result: { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } } };
    }
    return { proceed: false, result: ok(`Submission withheld: ${verdict.reason}`) };
  }
  const audit = await checkSavedForm(ctx);
  if (audit) return { proceed: false, result: audit };
  // What goes out is what is recorded, for a rehearsal as for a real submission.
  await recordWhatWasSent(ctx);
  if (!verdict.allowed) {
    ctx.log(`  ✋ dry run — withheld "${label}"`);
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'rehearsed', stoppedAt: ctx.page.url() } } };
  }
  // Every submission says whether a letter went with it: a letter is sent wherever the form has a place for one.
  if (ctx.coverLetter) {
    ctx.log(`  · cover letter included (${wasHumanized(ctx.coverLetter) ? 'humanized' : 'not humanized'})`);
  } else {
    // The evidence, not only the verdict: whether the whole page mentions a place for documents at all.
    // Every frame's and shadow root's text (Indeed's review section renders in on scroll; pageOffersDocuments has scrolled).
    const whole = (await Promise.all(ctx.page.frames().map((frame) => frame.evaluate(() => {
      const roots: Array<Document | ShadowRoot> = [document];
      for (let i = 0; i < roots.length; i++) {
        for (const element of roots[i].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
      }
      return roots.map((root) => (root instanceof Document ? root.body?.textContent : root.textContent) ?? '').join('\n');
    }).catch(() => '')))).join('\n');
    const mentions = [/cover[\s-]?letter/i, /supporting documents?/i, /additional documents?/i]
      .filter((pattern) => pattern.test(whole)).map((pattern) => pattern.source.replace(/\\s|\[|\]|-|\?/g, ' ').replace(/\s+/g, ' ').trim());
    ctx.log(`  · no cover letter: this form has no place for one (page mentions: ${mentions.join(', ') || 'none of cover letter / supporting documents'})`);
    // The whole page as sent, so "no place for a letter" can be seen rather than trusted.
    await ctx.page.screenshot({ path: resolve(config.dataDir, 'traces', `${ctx.job.id}-submit-no-letter.png`), fullPage: true, timeout: 10_000 }).catch(() => {});
  }
  if (!authorizeReservedSubmission(ctx.page.url())) {
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'needs-human',
      reason: 'Submission withheld: this exact form is reserved or may already have been sent, or the shared application limit is reached.' } } };
  }
  ctx.log(`  → submitting: "${label}"`);
  ctx.submissionAttempted = true;
  ctx.submitCleared = true;
  return { proceed: true, submit: true };
}

/**
 * Whether the page, read as it is and not as it is painted, has a control for
 * adding a cover letter or supporting documents. Indeed renders the lower part
 * of its review page lazily (content-visibility), so while it is off screen
 * both the observation and innerText skip "Supporting documents · Add", and
 * FTI Group was sent without the letter the form allowed. textContent and the
 * DOM do not depend on rendering.
 */
export async function pageOffersDocuments(page: Page): Promise<boolean> {
  /**
   * Rendered on scroll, not merely painted on scroll: Indeed's review page
   * does not put the Supporting documents section into the DOM until the
   * page has been scrolled towards it, so the walk below found nothing while
   * the full-page screenshot (which scrolls) showed the section plainly, and
   * Load Master went out without the letter. Walk the page to the bottom
   * first, in every frame, and leave it there — the agent re-observes anyway.
   */
  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      const step = Math.max(400, Math.floor(innerHeight * 0.8));
      for (let y = 0; y <= (document.body?.scrollHeight ?? 0); y += step) {
        scrollTo(0, y);
        await new Promise((done) => setTimeout(done, 120));
      }
      scrollTo(0, document.body?.scrollHeight ?? 0);
    }).catch(() => {});
  }
  await page.waitForTimeout(600).catch(() => {});
  const inFrame = async (frame: Frame) => frame.evaluate(() => {
    const place = /supporting documents?|additional documents?|cover[\s-]?letter/i;
    /*
     * Shadow roots included: Indeed's review section lives in one, so
     * document.body.textContent never contained "Supporting documents" and
     * Stake was sent without the letter too. Nameless and iterative — see the
     * note in observe.ts on named inner functions under tsx.
     */
    const roots: Array<Document | ShadowRoot> = [document];
    const controls: Element[] = [];
    for (let i = 0; i < roots.length; i++) {
      for (const element of roots[i].querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element.matches('button, a, [role="button"], label')) controls.push(element);
      }
    }
    return controls.some((control) => {
      const name = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`.replace(/\s+/g, ' ').trim();
      if (!/^(add|attach|upload|include|write)\b/i.test(name) && !place.test(name)) return false;
      // Up through the section around the control, crossing out of a shadow root to its host.
      let node: Element | null = control;
      for (let depth = 0; node && depth < 6; depth++) {
        if (place.test(node.textContent ?? '')) return true;
        const root = node.getRootNode();
        node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      }
      return false;
    });
  }).catch(() => false);
  for (const frame of page.frames()) {
    if (await inFrame(frame)) return true;
  }
  return false;
}

/** All tools advance through this same current-state review. No cached fill
 * outcome, pending label or raw-tool rejection can overrule its result. */
export async function checkSavedForm(ctx: ToolContext): Promise<ToolResult | null> {
  try {
    const form = await readSavedForm(ctx.page);
    const problems = await reviewSavedApplicationForm(form, ctx.job, ctx.profile);
    if (abandoned()) return ok('This review was abandoned; nothing was advanced.');
    const now = await readSavedForm(ctx.page);
    if (savedFormSignature(form) !== savedFormSignature(now)) {
      return ok('The saved form changed during verification. Re-observe before advancing; the earlier verdict is no longer valid.');
    }
    ctx.auditFailures = 0;
    const missingFacts = problems.filter(problem => problem.kind === 'needs_candidate');
    if (missingFacts.length) {
      for (const problem of missingFacts) {
        const field = form.fields.find(field => field.ref === problem.ref);
        ctx.guards.rememberField(field ? { ...field, ref: field.localRef } : { label: problem.field }, problem.problem);
        ctx.guards.recordUngrounded(problem.field);
      }
      return { kind: 'terminal', outcome: { status: 'needs-human', reason: `Your answer is needed for: ${missingFacts.map(problem => problem.field).join('; ')}` } };
    }
    const unsupported = problems.filter(problem => problem.kind === 'unsupported');
    if (unsupported.length) return withheldFor(ctx, unsupported);
    if (problems.length) return ok('The CURRENT saved form is not ready:\n' +
      problems.map(problem => `- ${problem.ref} ${problem.field}: ${problem.problem}`).join('\n') +
      '\nRepair these observed fields and check again. A missing or unaccepted selection is not a missing personal fact.');
    for (const field of form.fields) {
      // Clear only records for questions actually checked on this page.
      const labels = new Set([field.label, ...[...ctx.guards.pendingFields, ...ctx.guards.ungrounded,
        ...ctx.guards.unfillable.keys(), ...(ctx.rawAnswerProblems?.keys() ?? [])].filter(label => sameLabel(label, field.label))]);
      for (const label of labels) {
        ctx.guards.recordFillSuccess(label);
        ctx.rawAnswerProblems?.delete(label);
        ctx.auditStrikes?.delete(label);
      }
      const value = field.currentValue?.trim();
      if (value && !ctx.guards.siteControls.has(field.label)) {
        const prior = ctx.captured.findIndex(item => sameLabel(item.question, field.label));
        if (prior >= 0) ctx.captured.splice(prior, 1);
        ctx.captured.push({ question: field.label, answer: value });
      }
    }
    ctx.log('  · the current saved form passed AI verification');
    return null;
  } catch (error) {
    ctx.auditFailures = (ctx.auditFailures ?? 0) + 1;
    ctx.log(`  · saved-form review unavailable: ${String((error as Error).message).slice(0, 120)}`);
    if (ctx.auditFailures >= 2) return { kind: 'terminal', outcome: { status: 'skipped', reason: 'The saved form could not be verified before continuing.' } };
    return ok('The saved-form check could not run. Nothing was advanced or submitted. Wait, re-observe and try the same advance control again.');
  }
}

const sameLabel = (a: string, b: string) => {
  const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s*:]+$/, '');
  return normal(a) === normal(b);
};

/**
 * The question the candidate sees in Needs attention for a field the check
 * would not send. "What should Owtomate enter for 'Tell us more:'?" told them
 * nothing: not what the employer wants there, nor why the bot stopped. The
 * answer model writes the specific question, as it does for any field it
 * cannot answer; the fallback still names the job, the employer and the reason.
 */
async function candidateQuestion(
  ctx: ToolContext,
  field: FormField | undefined,
  problem: { field: string; value: string; problem: string },
): Promise<string> {
  // Short: it is read in a list. Why the old answer was withheld is in the run's steps.
  const fallback = `What should Owtomate enter for "${problem.field.replace(/[\s*:]+$/, '')}" on this ${ctx.job.company} application?`;
  if (!field) return fallback;
  const asked: FormField = {
    ...field,
    currentValue: '',
    description: `${field.description ? `${field.description}\n` : ''}Not sent: "${problem.value.slice(0, 200)}" — ${problem.problem}`,
  };
  const answer = await answerFields([asked], ctx.job, ctx.profile)
    .then((result) => result.answers.find((candidate) => candidate.ref === field.ref))
    .catch(() => undefined);
  return answer?.candidatePrompt?.trim() || fallback;
}

/** What the agent is told when answers on the form are not the candidate's; a field flagged twice goes to the candidate. */
async function withheldFor(ctx: ToolContext, problems: Array<{ field: string; value: string; problem: string }>): Promise<ToolResult | null> {
  if (!problems.length) return null;
  const strikes = (ctx.auditStrikes ??= new Map<string, number>());
  const candidateFields: string[] = [];
  // A model may describe two issues on one field. They are one failed review,
  // not two repair attempts; the agent must receive the feedback first.
  const reviewedFields = new Set<string>();
  ctx.log(`  ✋ pre-submit check: ${problems.length} unsupported answer(s): ${problems.map(p => `${p.field}: ${p.problem}`).join('; ').slice(0, 900)}`);
  for (const problem of problems) {
    const key = problem.field.replace(/\s+/g, ' ').trim().toLowerCase();
    if (reviewedFields.has(key)) continue;
    reviewedFields.add(key);
    const count = (strikes.get(problem.field) ?? 0) + 1;
    strikes.set(problem.field, count);
    if (count >= 2) {
      // Haiku's saved-form reviewer already separates missing required
      // high-risk facts as needs_candidate. A repeated unsupported draft is
      // an agent repair failure, not a new personal question for the user.
      if (applicationModelIdentity().selection === 'haiku') return { kind: 'terminal', outcome: {
        status: 'skipped', reason: 'The application answers could not be corrected against your saved information.',
      } };
      const field = ctx.observation.fields.find((candidate) => sameLabel(candidate.label, problem.field));
      ctx.guards.rememberField(field ?? { label: problem.field }, await candidateQuestion(ctx, field, problem));
      ctx.guards.recordUngrounded(problem.field);
      candidateFields.push(problem.field);
    }
  }
  if (candidateFields.length) {
    return { kind: 'terminal', outcome: {
      status: 'needs-human',
      reason: `These answers are not supported by your profile: ${candidateFields.slice(0, 3).join('; ')}`,
      detail: problems.map((p) => `${p.field}: ${p.problem}`).join('; '),
    } };
  }
  return ok(
    `Not sent on: these answers are not supported by the candidate's record:\n` +
    problems.map((p) => `- ${p.field}: "${p.value.slice(0, 80)}" — ${p.problem}`).join('\n') +
    '\nCorrect each one with answer_questions (a value the page already held goes in repair_refs, with your reason), ' +
    'or fill_element without a value for a field only the snapshot shows (both answer from the verified record), ' +
    (applicationModelIdentity().selection === 'haiku' ? 'For a rejected cover letter, use add_cover_letter with repair_feedback quoting the specific rejection; this creates a corrected draft instead of reusing it. ' : '') +
    'then press the same control again.',
  );
}

/**
 * Answers a general tool just put on the form, checked against the
 * candidate's record the moment they land.
 *
 * A script, a raw click or typed keys set a dropdown or a box without the
 * grounded answer path, and only the check at submit used to look at them:
 * the agent went on building a page on an answer it could not stand behind
 * (a Degree set by script on DTN's Workday form was caught at submit, three
 * pages later). The recorded changes say exactly what was set; the same
 * check as the submit audit reads them now, and the agent is told straight
 * away what the record does not support, while it is still on that page.
 */
export async function checkGeneralToolAnswers(ctx: ToolContext, changes: string[], committed?: PageChanges['values']): Promise<string> {
  const labels: string[] = [];
  for (const value of committed ?? []) {
    if (value.value.trim()) continue;
    const field = value.frame === 0 ? ctx.observation.fields.find(field => field.ref === value.ref) : undefined;
    const label = field?.label ?? value.name;
    ctx.rawAnswerProblems?.delete(label);
    if (field && !field.required) ctx.guards.resolveGrounding(label);
  }
  const set = committed ? committed.filter(value => value.value.trim()).map(value => {
    const field = value.frame === 0 ? ctx.observation.fields.find(field => field.ref === value.ref) : undefined;
    const label = field?.label ?? value.name;
    labels.push(label);
    return JSON.stringify({ field: label, value: value.value, section: field?.section, description: field?.description, required: field?.required });
  }) : changes.filter((change) =>
    /now holds|aria-checked: \S+ → true|checked: \S+ → |aria-selected: \S+ → true|class \+\S*(?:selected|checked|highlight|active)/i.test(change)
    && !/now holds \(hidden\)|now holds nothing/.test(change));
  if (!set.length) return '';
  let problems: Awaited<ReturnType<typeof auditFormBeforeSubmit>>;
  try {
    problems = await auditFormBeforeSubmit(
      `Answers just set on the form with a general browser tool (control: what changed):\n${set.map((change) => `- ${change}`).join('\n')}`,
      ctx.job, ctx.profile, ctx.captured,
      committed ? [...new Set(labels)] : undefined,
      ctx.page.url(),
    );
  } catch {
    if (committed) return '\nANSWER CHECK UNAVAILABLE: the committed browser changes could not be verified. Do not continue this attempt.';
    return '';
  }
  if (committed) {
    const issues = (ctx.rawAnswerProblems ??= new Map());
    for (const label of labels) if (!problems.some(problem => sameLabel(problem.field, label))) {
      if (issues.has(label)) ctx.guards.resolveGrounding(label);
      issues.delete(label);
      ctx.auditStrikes?.delete(label);
    }
    for (const problem of problems) {
      const label = labels.find(label => sameLabel(label, problem.field));
      if (!label) continue;
      issues.set(label, { ...problem, field: label });
    }
  }
  if (!problems.length) return '\nThe answers this set are supported by the candidate\'s record.';
  ctx.log(`  ✋ ${problems.length} answer(s) set by a general tool not supported: ${problems.map((problem) => problem.field).join('; ').slice(0, 160)}`);
  return `\nNOT SUPPORTED by the candidate's record, so this must not stay on the form: ${problems.map((problem) => `"${problem.field}" = "${problem.value}" (${problem.problem})`).join('; ')}. Put the right answer in with answer_questions or choose_option, or undo it; if the record has no answer, leave it for the candidate.`;
}

/**
 * Whether the page in front of the agent confirms this application was
 * received, read by the independent verifier (it must quote the page).
 * For an attempt that ends on a limit right after its submit: Accenture's
 * Workday form was submitted as the model allowance ran out, and the attempt
 * was reported as not sent because nothing looked at the page afterwards.
 */
export async function pageConfirmsSubmission(ctx: ToolContext, strict = false): Promise<boolean> {
  if (ctx.page.isClosed()) return false;
  await waitForPageToSettle(ctx.page, 1_500, 8_000).catch(() => false);
  const check = verifySubmissionEvidence(await submissionEvidence(ctx), ctx.job);
  return strict ? check : check.catch(() => false);
}

/**
 * The application's record is what the form held when it was sent, not what
 * Owtomate first wrote. Arinco's letter was corrected on the form after the
 * pre-submit check (the draft said "available immediately", the profile a
 * week's notice), and the dashboard kept showing the draft. Read just before
 * the submit is pressed: the letter box Owtomate wrote, and every answer it
 * gave, as the form now holds them.
 */
export async function recordWhatWasSent(ctx: ToolContext): Promise<void> {
  const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
  for (const frame of ctx.page.frames()) {
    const held = await frame.evaluate(() => {
      const box = document.querySelector('[data-owt-letter]') as HTMLTextAreaElement | HTMLInputElement | HTMLElement | null;
      if (!box) return null;
      return 'value' in box && typeof (box as HTMLTextAreaElement).value === 'string' ? (box as HTMLTextAreaElement).value : (box as HTMLElement).innerText;
    }).catch(() => null);
    if (held === null) continue;
    if (held.trim() && held.trim() !== (ctx.coverLetter ?? '').trim()) {
      ctx.coverLetter = held.trim();
      ctx.log('  · the letter on the form differs from the first draft; the one sent is recorded');
    }
    break;
  }
  const fields = await extractFields(ctx.page).catch(() => []);
  for (const item of ctx.captured) {
    const field = fields.find((candidate) => normal(candidate.label) === normal(item.question));
    const now = field && field.kind !== 'checkbox' && !field.sensitive ? field.currentValue?.trim() : '';
    if (now && normal(now) !== normal(item.answer)) item.answer = now;
  }
}

/**
 * Whether the application may move on without a cover letter, decided from
 * the agent's own statement checked against what the page shows.
 *
 * A word-matching rule used to decide: a page that merely mentioned a letter
 * held every forward press (APRA's Oracle form spent its step budget there),
 * and a letter section rendered out of view was missed (Indeed). Now an
 * ordinary step moves on unless it shows a letter control itself; the final
 * submit asks the agent once; and a statement that the form has no place
 * for a letter is accepted, after being questioned once if the page does
 * show one (a cover-letter control in view, or a supporting-documents
 * section anywhere on the page).
 */
async function coverLetterCheck(ctx: ToolContext, label: string, submit: boolean): Promise<ToolResult | null> {
  if (ctx.coverLetter || ctx.letterResolved || !(submit || movesForward(ctx, label))) return null;
  const shown = offersCoverLetter(ctx.observation);
  if (!shown && !submit) return null;
  const elsewhere = !shown && submit ? await pageOffersDocuments(ctx.page) : false;
  const stated = ctx.declaredNoLetter;
  if (stated) {
    if ((shown || elsewhere) && !ctx.letterChallenged) {
      ctx.letterChallenged = true;
      return ok(`You said the form has no place for a cover letter ("${stated.slice(0, 200)}"), but ${shown ? 'this step lists a cover-letter control in its FIELDS or ACTIONS' : 'the page has a supporting-documents or cover-letter section, possibly below or folded away'}. Add the letter with add_cover_letter (the writing FIELD, or the upload ACTION when it takes a file); if you have checked and it really cannot take one, press again with no_cover_letter_place saying why.`, 'document-prerequisite');
    }
    ctx.letterResolved = true;
    ctx.log(`  · no cover letter: ${stated.slice(0, 160)}`);
    return null;
  }
  return ok(shown
    ? 'This step has a place for a cover letter and none has been added. Add it with add_cover_letter (the writing FIELD, or the upload ACTION when it takes a file) before moving on; if it is not really a place for a letter, press again with no_cover_letter_place saying why.'
    : `This sends the application without a cover letter. If the form takes one anywhere (a cover-letter box, supporting documents, attachments; scroll down and open any Add control), add it with add_cover_letter; otherwise press again with no_cover_letter_place saying what you checked.${elsewhere ? ' The page does have a supporting-documents or cover-letter section.' : ''}`, 'document-prerequisite');
}
