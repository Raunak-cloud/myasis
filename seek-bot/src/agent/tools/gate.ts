import { waitForPageToSettle } from '../../browser.js';
import { extractFields } from '../../dom.js';
import { answerFields, isSubmitControl, reviewSavedApplicationForm, verifySubmissionEvidence } from '../../llm.js';
import { pickResumeForJob } from '../../resume.js';
import { createHash } from 'node:crypto';
import type { FormField } from '../../types.js';
import { isEntryAction } from '../guards.js';
import { wasHumanized } from '../../humanizer.js';
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
 * - a forward/submit control checks the current saved form once;
 * - a submit passes configuration policy (dry run and external scope);
 * - a second submit is pressed only once the first is known not to have gone
 *   through, since some forms confirm in place and pressing again sends the
 *   employer another copy;
 * - answer readiness is decided from the current saved form, not fill history.
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
  // Letter presence is descriptive, not an advancement prerequisite. The
  // navigator handles documents from the actual form; an existing letter
  // need not have been drafted by this attempt to be valid.
  if (ctx.coverLetter) ctx.log(`  cover letter included (${wasHumanized(ctx.coverLetter) ? 'humanized' : 'not humanized'})`);
  if (!authorizeReservedSubmission(ctx.page.url())) {
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'needs-human',
      reason: 'Submission withheld: this exact form is reserved or may already have been sent, or the shared application limit is reached.' } } };
  }
  ctx.log(`  → submitting: "${label}"`);
  ctx.submissionAttempted = true;
  ctx.submitCleared = true;
  return { proceed: true, submit: true };
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
        ...ctx.guards.unfillable.keys()].filter(label => sameLabel(label, field.label))]);
      for (const label of labels) {
        ctx.guards.recordFillSuccess(label);
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
