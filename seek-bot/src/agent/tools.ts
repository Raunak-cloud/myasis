import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'patchright';
import { config } from '../config.js';
import {
  captureInteractivePageState,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from '../browser.js';
import { ComboboxOptionsError, FieldRejectedError, fillField } from '../dom.js';
import { answerFields, coverLetterForJob } from '../llm.js';
import { RESUME_DIR, pickResumeForJob, selectResume } from '../resume.js';
import type { BlockedQuestion, CandidateProfile, JobListing } from '../types.js';
import type { Observation } from './observe.js';
import { RunGuards, isForbiddenDestination, isSubmitAction } from './guards.js';
import type { ToolSchema } from './celeris.js';
import { captchaEnabled, trySolveCaptcha } from '../captcha.js';
import { browserGmailAvailable, findCodeInBrowser } from '../browser-gmail.js';

/**
 * The agent's entire action surface.
 *
 * Two rules shape every tool here:
 *
 * 1. Actions are addressed by `ref` — a token this run stamped onto a real,
 *    visible element during the last observation. The model cannot pass a CSS
 *    selector, an XPath, a URL or JavaScript, so it cannot reach anything we
 *    did not just offer it.
 * 2. The model chooses *which* control to act on. It never authors the text
 *    that goes into an employer's form: answers come from the existing
 *    grounded path in gemini.ts, which refuses to invent facts and flags
 *    anything it cannot support.
 */

export type AgentTermination =
  | { status: 'applied' }
  | { status: 'rehearsed'; stoppedAt: string }
  | {
      status: 'needs-human';
      /** Plain language, shown to the candidate. */
      reason: string;
      /** The technical version, for the log and the trace only. */
      detail?: string;
      questions?: BlockedQuestion[];
    }
  | { status: 'off-platform'; redirectedTo: string }
  | { status: 'skipped'; reason: string };

export type ToolResult = { kind: 'ok'; message: string } | { kind: 'terminal'; outcome: AgentTermination };

export interface ToolContext {
  page: Page;
  job: JobListing;
  profile: CandidateProfile;
  guards: RunGuards;
  /** Replaced after every action; refs are only valid against this. */
  observation: Observation;
  /** Everything this run would transmit, so a dry run can show it. */
  captured: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  resumeUsed?: string;
  /** Drafted in parallel with the apply UI opening. */
  prefetchedLetter?: Promise<{ letter?: string; error?: Error }>;
  log: (line: string) => void;
}

const ok = (message: string): ToolResult => ({ kind: 'ok', message });

const EMAILED_CODE_TOOL: ToolSchema = {
  name: 'enter_emailed_code',
  description:
    'When the page asks for a code that was emailed to the candidate (verification code, one-time passcode, sign-in code), ' +
    "call this with the ref of the code FIELD after the email has been requested. The code is read from the candidate's " +
    'inbox and typed into that field for you. Never type a code yourself.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'The FIELD ref of the code input.' },
      sender_hint: { type: 'string', description: 'The site or company that sent the code, e.g. "Oracle" or "Workday".' },
    },
    required: ['ref'],
  },
};

const CLICK_POINT_TOOL: ToolSchema = {
  name: 'click_point',
  description:
    'Last resort, only when the screenshot shows something you need to click that has no ref: click at a point. ' +
    'Coordinates are on a 0-1000 grid over the screenshot, x left to right, y top to bottom. Prefer click with a ref whenever one exists.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: '0-1000, left to right' },
      y: { type: 'number', description: '0-1000, top to bottom' },
      reason: { type: 'string', description: 'What you are clicking and why.' },
    },
    required: ['x', 'y', 'reason'],
  },
};

/**
 * The tools the model may call this turn: the base set, whatever the account
 * has connected, and pointing only while a screenshot is in front of it.
 */
export function toolSchemas(options: { vision?: boolean } = {}): ToolSchema[] {
  return [
    ...TOOL_SCHEMAS,
    ...(browserGmailAvailable() ? [EMAILED_CODE_TOOL] : []),
    ...(options.vision ? [CLICK_POINT_TOOL] : []),
  ];
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'click',
    description:
      'Click one control from the ACTIONS list to move the application forward. Use the ref exactly as listed. ' +
      'Use this for Continue, Next, Review, Submit, radio-like buttons, and for dismissing dialogs.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the current ACTIONS list, e.g. "a4".' },
        reason: { type: 'string', description: 'Why this control advances the application.' },
      },
      required: ['ref', 'reason'],
    },
  },
  {
    name: 'answer_questions',
    description:
      'Answer employer questions. Pass the refs of every FIELD on this step that is a question for the applicant. ' +
      'You do NOT write the answers — they are generated from the verified candidate profile and filled in for you. ' +
      'Do not include the cover-letter textarea or file inputs here.',
    parameters: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field refs from the current FIELDS list, e.g. ["f0","f2"].',
        },
        reason: { type: 'string', description: 'What this step is asking for.' },
      },
      required: ['refs', 'reason'],
    },
  },
  {
    name: 'add_cover_letter',
    description:
      'Handle the whole cover-letter step: selects the "write a cover letter" option if one is needed and writes ' +
      'the tailored letter. Call this whenever a step mentions a cover letter, optional or not. Takes no arguments.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'attach_resume',
    description:
      'Handle the resume/CV/document step. Call this whenever the step is about choosing or attaching a resume — ' +
      'whether it shows a list of existing documents to pick from or a file upload. Takes no arguments: the resume ' +
      'for this run is already chosen. Never use answer_questions for a resume step.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'scroll',
    description: 'Scroll the page when the step clearly continues below or above the visible area.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['down', 'up'] } },
      required: ['direction'],
    },
  },
  {
    name: 'finish',
    description:
      'Give up on this application: a human is required, the flow has left this job board, or there is nothing to ' +
      'apply to. This is NOT how an application is completed — to submit, click the submit control. There is no ' +
      '"submitted" status here because success is detected from the page, never declared.',
    parameters: {
      type: 'object',
      properties: {
        /**
         * Deliberately no "submitted" option.
         *
         * An earlier version listed one and told the model in prose never to
         * use it; on a live run it reached for it anyway and reported success
         * on an application it had not submitted. Withholding the option is a
         * schema-level guarantee — the prose was only a request.
         */
        status: {
          type: 'string',
          enum: ['needs_human', 'off_platform', 'nothing_to_apply_to'],
        },
        reason: { type: 'string', description: 'One sentence, specific.' },
      },
      required: ['status', 'reason'],
    },
  },
];

/**
 * Clicks a stamped ref.
 *
 * Patchright's CSS engine pierces open shadow roots, so the locator handles
 * SEEK's web components and gets real actionability checks. The JS fallback
 * covers controls a locator refuses to click — most often one sitting under an
 * open dialog.
 */
async function clickRef(page: Page, ref: string): Promise<boolean> {
  const locator = page.locator(`[data-ref-id="${ref}"]`).first();
  const clicked = await locator
    .click({ timeout: 6_000 })
    .then(() => true)
    .catch(() => false);
  if (clicked) return true;

  return page
    .evaluate((wanted) => {
      // Nameless and iterative — see the note in observe.ts: a named inner
      // function here throws "__name is not defined" under tsx.
      const roots: Array<Document | ShadowRoot> = [document];
      while (roots.length) {
        const root = roots.pop()!;
        for (const element of root.querySelectorAll('*')) {
          if (element.getAttribute('data-ref-id') === wanted && element instanceof HTMLElement) {
            element.click();
            return true;
          }
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      return false;
    }, ref)
    .catch(() => false);
}

async function doClick(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const action = ctx.observation.actions.find((candidate) => candidate.ref === ref);
  if (!action) {
    // Observed live: the model reached for a FIELD ref here, then floundered.
    // Point it at the right tool instead of just refusing.
    if (/^f\d+$/.test(ref)) {
      return ok(
        `"${ref}" is a FIELD, not a clickable action. Fields are not clicked: use answer_questions for employer ` +
          `questions, attach_resume for a resume step, or add_cover_letter for a cover letter. ACTIONS use "a" refs.`,
      );
    }
    return ok(`No action "${ref}" exists on this page. Choose a ref from the current ACTIONS list.`);
  }
  if (action.disabled) {
    return ok(
      `"${action.text}" is disabled — the step is not satisfied yet. Answer the remaining required fields first.`,
    );
  }

  /**
   * The submit gate. Every route to transmitting an application passes through
   * `canSubmit`, and it reads configuration and recorded facts only — the
   * model's stated reason has no bearing on it.
   */
  if (isSubmitAction(action.text)) {
    const verdict = ctx.guards.canSubmit(ctx.page.url());
    if (!verdict.allowed) {
      if (verdict.kind === 'dry-run') {
        ctx.log(`  ✋ dry run — withheld "${action.text}"`);
        return { kind: 'terminal', outcome: { status: 'rehearsed', stoppedAt: ctx.page.url() } };
      }
      if (verdict.kind === 'off-platform') {
        return { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } };
      }
      return { kind: 'terminal', outcome: { status: 'needs-human', reason: verdict.reason, detail: verdict.detail } };
    }
    ctx.log(`  → submitting: "${action.text}"`);
  }

  if (action.role === 'link') {
    const href = await ctx.page
      .locator(`[data-ref-id="${ref}"]`)
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (href) {
      const destination = new URL(href, ctx.page.url()).href;
      if (isForbiddenDestination(destination)) {
        return ok(`Refused: "${action.text}" leads to ${destination}, which this tool never navigates to.`);
      }
    }
  }

  const before = await captureInteractivePageState(ctx.page);
  if (!(await clickRef(ctx.page, ref))) {
    return ok(`Could not click "${action.text}". It may be covered by a dialog — try closing that first.`);
  }
  const changed = await waitForInteractivePageChange(ctx.page, before);
  await waitForInteractiveSurface(ctx.page, 4_000);

  return ok(
    changed
      ? `Clicked "${action.text}". The page changed; a fresh observation follows.`
      : isSubmitAction(action.text)
        ? `Clicked "${action.text}" but the form did not submit. A form that refuses to submit almost always shows a validation message beside an incomplete required field, often near the top: scroll up, re-observe, and answer or fix the field it names before trying again.`
        : `Clicked "${action.text}" but nothing on the page changed. It was probably not the control that advances this step — try a different one.`,
  );
}

async function doAnswerQuestions(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
  const asked = ctx.observation.fields.filter((field) => refs.includes(field.ref));

  /**
   * A password is not a question anybody can answer on the candidate's behalf.
   *
   * Some employers make you create an account partway through applying, so
   * "Choose Password" arrives looking like an employer question. It must not
   * be answered, and above all must not be added to the pending list, because
   * that list is what the dashboard turns into "answer this and we will reuse
   * it" — plain text, replayed at every later employer asking the same thing.
   */
  const credentials = asked.filter((field) => field.sensitive);
  const wanted = asked.filter((field) => !field.sensitive);
  if (credentials.length) {
    return {
      kind: 'terminal',
      outcome: {
        status: 'needs-human',
        reason:
          `This employer requires creating an account (${credentials.map((f) => f.label).join(', ')}). ` +
          'Passwords are never set or stored here, so this one has to be finished by hand.',
      },
    };
  }

  if (!wanted.length) {
    return ok('None of those refs are fields on this page. Choose refs from the current FIELDS list.');
  }

  const { answers, injectionSuspected } = await answerFields(wanted, ctx.job, ctx.profile);
  if (injectionSuspected) {
    ctx.log('  ⚠ prompt-injection attempt detected in this listing — ignored');
  }

  const filled: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  /** Required fields the answerer has already refused once — asking again cannot help. */
  const repeated: string[] = [];
  for (const field of wanted) {
    ctx.guards.pendingFields.add(field.label);
    ctx.guards.rememberField(field);
  }
  for (const answer of answers) {
    const field = wanted.find((candidate) => candidate.ref === answer.ref);
    if (!field) continue;

    /**
     * Unsupported answers are never invented. A required one blocks
     * submission until a person resolves it; an optional one is simply left
     * blank — referral fields and "anything else?" boxes used to stop whole
     * applications for no reason.
     */
    if (!answer.grounded) {
      if (!field.required) {
        ctx.guards.pendingFields.delete(field.label);
        ctx.guards.skippedOptional.add(field.label);
        skipped.push(field.label);
        continue;
      }
      if (ctx.guards.ungrounded.includes(field.label)) repeated.push(field.label);
      ctx.guards.recordUngrounded(field.label);
      continue;
    }

    let value = answer.value;
    try {
      await fillField(ctx.page, field, value);
    } catch (error) {
      /**
       * A dropdown's choices are only visible once it opens, so the first
       * answer was given blind. Ask once more with the real list, the way a
       * person reads the menu before choosing.
       */
      if (error instanceof ComboboxOptionsError || error instanceof FieldRejectedError) {
        /**
         * With options, the re-ask is a choice from a known list. Otherwise
         * the reason has to travel with the field — a search that matched
         * nothing, or the form's own complaint about the value — because the
         * label alone would produce the identical answer and the identical
         * rejection a second time.
         */
        const reask =
          error instanceof ComboboxOptionsError && error.options.length
            ? { ...field, options: error.options }
            : { ...field, label: `${field.label} — ${error.message}` };
        // A combobox's real choices are only known now; keep them for the person too.
        if (error instanceof ComboboxOptionsError && error.options.length) ctx.guards.rememberField(reask);
        const again = await answerFields([reask], ctx.job, ctx.profile);
        const retry = again.answers[0];
        if (!retry?.grounded) {
          if (!field.required) {
            ctx.guards.pendingFields.delete(field.label);
            ctx.guards.skippedOptional.add(field.label);
            skipped.push(field.label);
            continue;
          }
          ctx.guards.recordUngrounded(field.label);
          continue;
        }
        value = retry.value;
        try {
          await fillField(ctx.page, field, value);
        } catch (secondError) {
          failed.push(`${field.label}: ${(secondError as Error).message}`);
          continue;
        }
      } else {
        failed.push(`${field.label}: ${(error as Error).message}`);
        continue;
      }
    }
    ctx.guards.resolveGrounding(field.label);
    ctx.guards.pendingFields.delete(field.label);
    const prior = ctx.captured.findIndex(item => item.question === field.label);
    if (prior >= 0) ctx.captured.splice(prior, 1);
    ctx.captured.push({ question: field.label, answer: value });
    filled.push(`${field.label} → ${value.slice(0, 60)}`);
  }

  if (filled.length) ctx.guards.recordProgress();
  const ungroundedNow = ctx.guards.ungrounded.length;
  return ok(
    (failed.length ? `Not accepted; re-observe and recover:\n${failed.join("\n")}\n` : '') +
    `Verified ${filled.length} field(s):\n${filled.map((line) => `  - ${line}`).join('\n')}` +
      (skipped.length ? `\nLeft blank (optional, nothing in the profile supports an answer): ${skipped.join('; ')}` : '') +
      (repeated.length
        ? `\nSTOP asking about: ${repeated.join('; ')}. These required questions have no answer in the candidate's profile and calling answer_questions again cannot change that — only the candidate can supply them. Finish with status "needs_human" now.`
        : '') +
      (ungroundedNow
        ? `\nWARNING: ${ungroundedNow} answer(s) could not be grounded in the candidate profile. This application cannot be submitted; finish with status "needs_human" once you have nothing else useful to do.`
        : ''),
  );
}

/**
 * Handles the whole cover-letter step, radio included.
 *
 * On SEEK the textarea is in the DOM but hidden until "Write a cover letter" is
 * chosen, so a tool that only filled a textarea would fail on the common case
 * and depend on the model clicking exactly the right radio first. Doing the
 * whole step here mirrors the deterministic `maybeCoverLetter` and removes that
 * failure mode.
 */
async function doAddCoverLetter(ctx: ToolContext): Promise<ToolResult> {
  const page = ctx.page;

  const writeOption = page.getByRole('radio', { name: /write a cover letter|add a cover letter/i }).first();
  if (await writeOption.count().catch(() => 0)) {
    await writeOption.check({ force: true }).catch(() => {});
    await jitter(400, 900);
  }

  const textarea = page.locator('textarea:visible').first();
  try {
    await textarea.waitFor({ state: 'visible', timeout: 6_000 });
  } catch {
    return ok('No cover-letter box appeared on this step. Move on to the next step.');
  }

  /**
   * Always regenerate — never keep what is already in the box.
   *
   * SEEK persists the last cover letter you typed and pre-fills it into the
   * next application, so trusting it means addressing one employer by another
   * employer's name.
   */
  const existing = await textarea.inputValue().catch(() => '');
  if (existing.trim().length > 40 && !existing.toLowerCase().includes(ctx.job.company.toLowerCase())) {
    ctx.log(`  ! discarded a stale pre-filled cover letter (not addressed to ${ctx.job.company})`);
  }

  const draft = ctx.prefetchedLetter
    ? await ctx.prefetchedLetter
    : { letter: await coverLetterForJob(ctx.job, ctx.profile) };
  if (draft.error) throw draft.error;
  if (!draft.letter) throw new Error('Cover-letter drafting returned no text.');

  await textarea.fill(draft.letter, { timeout: 10_000 });
  if (await textarea.inputValue() !== draft.letter) throw new Error('Cover letter did not retain the drafted text');
  ctx.coverLetter = draft.letter;
  if (config.coverLetter.mode === 'reuse') ctx.log('  ↻ reusable cover letter selected');
  return ok(
    `Cover letter written (${draft.letter.split(/\s+/).length} words), addressed to ${ctx.job.company}. ` +
      'The cover-letter step is DONE — click the forward control next.',
  );
}

/**
 * Handles the résumé step, whatever shape it takes.
 *
 * SEEK's "Choose documents" step is a radio list of documents already on the
 * account, not a file input — `selectResume` already knows how to tick it,
 * including the Braid radios that never report `checked`. Without a tool for
 * this the agent tried to route the step through `answer_questions` and looped
 * on it until the step budget ran out, which is exactly what a live run did.
 */
async function doAttachResume(ctx: ToolContext): Promise<ToolResult> {
  const wanted = await pickResumeForJob(ctx.job, ctx.profile);

  const outcome = await selectResume(ctx.page, wanted, config.resume.allowUpload).catch(
    (error: Error) => ({ status: 'error' as const, message: error.message }),
  );

  if ('message' in outcome) return ok(`Resume step failed: ${outcome.message}`);

  switch (outcome.status) {
    case 'selected':
    case 'uploaded':
      ctx.resumeUsed = outcome.name;
      return ok(`Resume "${outcome.name}" ${outcome.status}. Move on to the next step.`);
    case 'unavailable':
      return ok(
        `The resume for this run ("${outcome.wanted}") is not on the account and uploading is disabled. ` +
          `Available: ${outcome.available.join(', ') || 'none'}. Finish with "needs_human".`,
      );
    case 'kept-default':
      if (outcome.name !== '(no document step)') {
        ctx.resumeUsed = outcome.name;
        return ok(`Kept the default resume ("${outcome.name}"). Move on to the next step.`);
      }
      break;
  }

  // Not a SEEK document step — fall back to a plain file input, which is what
  // external ATS forms use.
  const fileAction = ctx.observation.actions.find((candidate) => candidate.role === 'file');
  if (!fileAction) return ok('There is no resume step on this page. Move on.');

  const locator = ctx.page.locator(`[data-ref-id="${fileAction.ref}"]`).first();
  const already = await locator.inputValue().catch(() => '');
  if (already) {
    ctx.resumeUsed = already.replace(/^.*[\\/]/, '');
    return ok(`A file is already attached (${ctx.resumeUsed}); nothing to do.`);
  }
  if (!wanted) return ok('No resume is selected for this run, so nothing can be attached.');
  const localPath = resolve(RESUME_DIR, wanted.fileName);
  if (!existsSync(localPath)) return ok(`The selected resume file is missing: ${wanted.fileName}.`);

  try {
    await locator.setInputFiles(localPath, { timeout: 15_000 });
    ctx.resumeUsed = wanted.fileName;
    return ok(`Attached ${wanted.fileName}.`);
  } catch (error) {
    return ok(`Upload failed: ${(error as Error).message}`);
  }
}

async function doScroll(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const direction = args.direction === 'up' ? -1 : 1;
  await ctx.page.evaluate((sign) => window.scrollBy(0, sign * Math.round(window.innerHeight * 0.8)), direction);
  await jitter(300, 700);
  return ok(`Scrolled ${direction === 1 ? 'down' : 'up'}.`);
}

async function doFinish(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const reason = String(args.reason ?? 'no reason given');
  switch (String(args.status)) {
    case 'submitted':
      /**
       * The model does not get to declare success. Only `detectConfirmation`
       * does, and the loop checks it before every turn — so if we are here,
       * the page never showed a confirmation and this is a needs-human.
       */
      return {
        kind: 'terminal',
        outcome: {
          status: 'needs-human',
          reason: 'The application was not confirmed as submitted.',
          detail: `agent claimed submission but no confirmation page was reached: ${reason}`,
        },
      };
    case 'off_platform':
      return { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } };
    case 'nothing_to_apply_to':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    default:
      // The agent met a challenge. With click-solving on, one attempt is
      // made before a person is asked; if it clears, the agent carries on.
      if (/captcha|robot|verify you are human|bot check|security verification/i.test(reason) && captchaEnabled()) {
        if (await trySolveCaptcha(ctx.page)) return ok('The challenge was cleared. Re-observe the page and continue.');
      }
      return { kind: 'terminal', outcome: { status: 'needs-human', reason } };
  }
}

/**
 * A click by coordinates, for the rare control no ref reaches. The same
 * rails as a ref click apply: the element under the point is inspected
 * first, so a submit still passes `canSubmit` and a forbidden link is still
 * refused. celeris-1 places these on a 0-1000 grid to within a few pixels.
 */
async function doClickPoint(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.observation.screenshot) return ok('click_point is only available while a screenshot is in front of you. Use click with a ref.');
  const gx = Number(args.x);
  const gy = Number(args.y);
  if (!(gx >= 0 && gx <= 1000 && gy >= 0 && gy <= 1000)) return ok('x and y must be numbers on the 0-1000 grid.');
  const size = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 800 }));
  const x = (gx / 1000) * size.width;
  const y = (gy / 1000) * size.height;
  const under = await ctx.page
    .evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        const clickable = element.closest('a, button, [role], label, input, select, textarea') ?? element;
        const link = clickable.closest('a[href]');
        return {
          tag: clickable.tagName,
          text: ((clickable as HTMLElement).innerText || clickable.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          href: link ? (link as HTMLAnchorElement).href : null,
        };
      },
      { x, y },
    )
    .catch(() => null);
  if (!under) return ok('Nothing is under that point. Re-observe and try a ref or a different point.');
  if (under.href && isForbiddenDestination(under.href)) {
    return ok(`Refused: that point is a link to ${under.href}, which this tool never navigates to.`);
  }
  if (isSubmitAction(under.text)) {
    const verdict = ctx.guards.canSubmit(ctx.page.url());
    if (!verdict.allowed) {
      if (verdict.kind === 'dry-run') {
        ctx.log(`  ✋ dry run — withheld "${under.text}"`);
        return { kind: 'terminal', outcome: { status: 'rehearsed', stoppedAt: ctx.page.url() } };
      }
      if (verdict.kind === 'off-platform') {
        return { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } };
      }
      return { kind: 'terminal', outcome: { status: 'needs-human', reason: verdict.reason, detail: verdict.detail } };
    }
    ctx.log(`  → submitting: "${under.text}"`);
  }
  const before = await captureInteractivePageState(ctx.page);
  await ctx.page.mouse.click(x, y);
  const changed = await waitForInteractivePageChange(ctx.page, before);
  await waitForInteractiveSurface(ctx.page, 4_000);
  return ok(
    `Clicked at (${gx},${gy}) on <${under.tag.toLowerCase()}> "${under.text}". ` +
      (changed ? 'The page changed; a fresh observation follows.' : 'Nothing on the page changed.'),
  );
}

async function doEnterEmailedCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!browserGmailAvailable()) {
    return ok('No mailbox is signed in for this candidate. Finish with "needs_human".');
  }
  const field = ctx.observation.fields.find((candidate) => candidate.ref === String(args.ref ?? ''));
  if (!field) return ok("That ref is not a FIELD on this page. Choose the code input's ref from the current FIELDS list.");
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification code');

  const found = await findCodeInBrowser(ctx.page.context(), { hint, timeoutMs: 90_000, log: ctx.log });
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    /**
     * A signed-out mailbox is not a slow email, and calling this again will
     * not fix it. Saying so ends the attempt in one step instead of spending
     * another ninety seconds finding out the same thing.
     */
    if (/signed out/i.test(found.error)) return ok(`${found.error} Finish with "needs_human".`);
    return ok('No verification email arrived within 90 seconds. If the page has a resend control, click it and call this again once; otherwise finish with "needs_human".');
  }

  await fillField(ctx.page, field, found.code);
  ctx.guards.recordProgress();
  ctx.log(`  ✉ entered the code from "${found.subject.slice(0, 60)}"`);
  return ok(`Entered the emailed code into "${field.label}". Continue with the next control.`);
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if ('__parseError' in args) {
    return ok('Your tool arguments were not valid JSON. Call the tool again with well-formed arguments.');
  }
  switch (name) {
    case 'click':
      return doClick(ctx, args);
    case 'answer_questions':
      return doAnswerQuestions(ctx, args);
    case 'add_cover_letter':
      return doAddCoverLetter(ctx);
    case 'attach_resume':
      return doAttachResume(ctx);
    case 'scroll':
      return doScroll(ctx, args);
    case 'finish':
      return doFinish(ctx, args);
    case 'enter_emailed_code':
      return doEnterEmailedCode(ctx, args);
    case 'click_point':
      return doClickPoint(ctx, args);
    default:
      return ok(`No such tool "${name}".`);
  }
}
