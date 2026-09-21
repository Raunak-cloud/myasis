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
import { answerFields, finishedCoverLetterForJob } from '../llm.js';
import { RESUME_DIR, pickResumeForJob, selectResume } from '../resume.js';
import type { ApplicationAction, BlockedQuestion, CandidateProfile, JobListing } from '../types.js';
import type { Observation } from './observe.js';
import { RunGuards, isEntryAction, isExternal, isForbiddenDestination, isSubmitAction } from './guards.js';
import type { ToolSchema } from './celeris.js';
import { captchaEnabled, trySolveCaptcha } from '../captcha.js';
import { browserGmailAvailable, findCodeInBrowser } from '../browser-gmail.js';
import { authenticationValue, hostOf } from '../site-auth.js';
import { isAustralianGovernmentUrl } from '../site-policy.js';

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
  | { status: 'already-applied'; reason: string }
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
  log: (line: string) => void;
  /** Side effects the candidate must be told about — see `ApplicationAction`. */
  actions: ApplicationAction[];
}

const ok = (message: string): ToolResult => ({ kind: 'ok', message });

/** Records a side effect once per kind and site, and says so in the run log. */
function noteAction(ctx: ToolContext, action: Omit<ApplicationAction, 'at'>): void {
  if (ctx.actions.some((known) => known.kind === action.kind && known.site === action.site)) return;
  ctx.actions.push({ ...action, at: new Date().toISOString() });
}

/** A site named the way the candidate knows it. */
function siteName(host: string): string {
  if (/(^|\.)seek\.com(\.au)?$/.test(host)) return 'SEEK';
  if (/(^|\.)indeed\.com$/.test(host)) return 'Indeed';
  return host;
}

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
    name: 'complete_authentication',
    description:
      'Fill sign-in or account-creation fields using the candidate profile and the private site credential. ' +
      'Use this for email, username, name, phone, password and password-confirmation fields. Pass every authentication FIELD on the page. ' +
      'Do not use answer_questions for credentials. After filling, click the sign-in, create-account or continue control.',
    parameters: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Authentication field refs from the current FIELDS list.',
        },
        purpose: {
          type: 'string',
          enum: ['sign_in', 'create_account', 'reset_password'],
          description: 'What this page does with the credential: sign in to an existing account, create a new one, or set a new password.',
        },
        reason: { type: 'string', description: 'What on the page shows that purpose.' },
      },
      required: ['refs', 'purpose', 'reason'],
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
      'End this attempt without submitting: the job was already applied to, a human is required, the flow has left ' +
      'this job board, or there is nothing to apply to. This is NOT how an application is completed — to submit, click the submit control. There is no ' +
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
          enum: ['needs_human', 'cannot_complete', 'off_platform', 'already_applied', 'nothing_to_apply_to'],
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
  const entry = isEntryAction(action.text, { captured: ctx.captured.length, fields: ctx.observation.fields.length });
  if (entry) ctx.log(`  → opening the application: "${action.text}"`);
  if (isSubmitAction(action.text) && !entry) {
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
      if (isAustralianGovernmentUrl(destination)) {
        return {
          kind: 'terminal',
          outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
        };
      }
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

async function doCompleteAuthentication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (isAustralianGovernmentUrl(ctx.page.url())) {
    return {
      kind: 'terminal',
      outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
    };
  }

  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
  const fields = ctx.observation.fields.filter((field) => refs.includes(field.ref));
  if (!fields.length) {
    return ok('None of those refs are authentication fields on this page. Choose refs from the current FIELDS list.');
  }

  const values = fields.map((field) => ({ field, value: authenticationValue(field, ctx.profile, ctx.page.url()) }));
  const unsupported = values.filter((entry) => entry.value === null);
  const missingCredential = unsupported.some((entry) => entry.field.sensitive);
  if (missingCredential) {
    return ok('The private site credential is unavailable. Finish with "cannot_complete" so this job is skipped.');
  }

  const filled: string[] = [];
  const failed: string[] = [];
  for (const { field, value } of values) {
    if (value === null) continue;
    try {
      await fillField(ctx.page, field, value);
      ctx.guards.recordFillSuccess(field.label);
      filled.push(field.label);
    } catch (error) {
      failed.push(`${field.label}: ${(error as Error).message}`);
    }
  }

  if (filled.length) ctx.guards.recordProgress();
  /**
   * The candidate now has, or has used, an account they may never have heard
   * of. The purpose is the agent's own reading of the page; the password is
   * not recorded, because the dashboard can derive it again for its owner.
   */
  const credentialFilled = values.some(
    ({ field, value }) => value !== null && (field.sensitive || field.inputType === 'password') && filled.includes(field.label),
  );
  if (credentialFilled) {
    const site = hostOf(ctx.page.url());
    const email = ctx.profile.email;
    const purpose = String(args.purpose ?? '');
    if (purpose === 'create_account') {
      noteAction(ctx, { kind: 'account-created', site, email, detail: `Created an account on ${siteName(site)} with ${email}.` });
    } else if (purpose === 'reset_password') {
      noteAction(ctx, { kind: 'password-reset', site, email, detail: `Set a new password for your account on ${siteName(site)}.` });
    } else {
      noteAction(ctx, { kind: 'signed-in', site, email, detail: `Signed in to your account on ${siteName(site)} with ${email}.` });
    }
  }
  return ok(
    `${filled.length} authentication field(s) completed${filled.length ? `: ${filled.join('; ')}` : ''}.` +
      (unsupported.length
        ? ` Use answer_questions for the remaining profile field(s): ${unsupported.map((entry) => `${entry.field.ref} (${entry.field.label})`).join(', ')}.`
        : '') +
      (failed.length ? ` Re-observe and retry fields the site rejected: ${failed.join('; ')}` : '') +
      ' Continue with the sign-in or account-creation control.',
  );
}

async function doAnswerQuestions(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
  const asked = ctx.observation.fields.filter((field) => refs.includes(field.ref));

  // A prefilled text/select/radio value is already an answer. Re-answering it
  // can overwrite an account value and, if the model refuses, turn a complete
  // contact field into a bogus task for the candidate.
  const alreadyComplete = asked.filter((field) =>
    field.kind === 'checkbox'
      ? field.currentValue === 'true'
      : Boolean(field.currentValue?.trim()),
  );
  for (const field of alreadyComplete) {
    ctx.guards.pendingFields.delete(field.label);
    ctx.guards.resolveGrounding(field.label);
  }

  /**
   * A password is not a question anybody can answer on the candidate's behalf.
   *
   * Some employers make you create an account partway through applying, so
   * "Choose Password" arrives looking like an employer question. It must not
   * be answered, and above all must not be added to the pending list, because
   * that list is what the dashboard turns into "answer this and we will reuse
   * it" — plain text, replayed at every later employer asking the same thing.
   */
  const credentials = asked.filter((field) => field.sensitive && !alreadyComplete.includes(field));
  /**
   * A control already proved unusable is not answered again. The answer was
   * never the problem, so a second model call produces the same value, the
   * same rejection and one less step to finish the application with.
   */
  const unusable = asked.filter(
    (field) => !field.sensitive && !alreadyComplete.includes(field) && ctx.guards.unfillable.has(field.label),
  );
  const wanted = asked.filter(
    (field) => !field.sensitive && !alreadyComplete.includes(field) && !ctx.guards.unfillable.has(field.label),
  );
  if (credentials.length) {
    return ok(
      `Use complete_authentication for credential fields: ${credentials.map((field) => `${field.ref} (${field.label})`).join(', ')}.`,
    );
  }

  const unusableNote = unusable.length
    ? `This form will not let anything be entered in: ${unusable
        .map((field) => `${field.label} (${ctx.guards.unfillable.get(field.label)})`)
        .join('; ')}. Do not answer ${unusable.length > 1 ? 'those' : 'that'} again. `
    : '';

  if (!wanted.length) {
    if (unusable.length) {
      return ok(
        `${unusableNote}Carry on with the rest of the form if anything remains, or finish with status ` +
          `"cannot_complete" if this control is the only thing left.`,
      );
    }
    return ok(alreadyComplete.length
      ? 'Those fields are already complete. Continue with the next unanswered application field or the forward control.'
      : 'None of those refs are fields on this page. Choose refs from the current FIELDS list.');
  }

  const first = await answerFields(wanted, ctx.job, ctx.profile);
  let answers = first.answers;
  let injectionSuspected = first.injectionSuspected;
  /**
   * Before a required question goes to the candidate, the reasoning model
   * gets one look at it. The fast model answers most questions well, but a
   * question it could not place — a phone code split from the number, a date
   * spread over three boxes — is usually one that a moment's thought resolves,
   * and a paused application costs the candidate far more than a slower call.
   */
  const unsure = wanted.filter((field) =>
    field.required &&
    !ctx.guards.ungrounded.includes(field.label) &&
    answers.some((answer) => answer.ref === field.ref && answer.applicationQuestion !== false && !answer.grounded),
  );
  if (unsure.length) {
    ctx.log(`  ↑ thinking again about ${unsure.length} question(s) before asking the candidate`);
    const second = await answerFields(unsure, ctx.job, ctx.profile, undefined, { reasoning: true }).catch(() => null);
    if (second) {
      answers = answers.map((answer) => {
        const better = second.answers.find((candidate) => candidate.ref === answer.ref);
        return better && (better.grounded || better.applicationQuestion === false) ? better : answer;
      });
      injectionSuspected ||= second.injectionSuspected;
    }
  }
  if (injectionSuspected) {
    ctx.log('  ⚠ prompt-injection attempt detected in this listing — ignored');
  }

  const filled: string[] = [];
  const failed: string[] = [];
  /** Controls that have now refused twice: reported once, then never retried. */
  const blocked: string[] = [];
  const skipped: string[] = [];
  const unrelated: string[] = [];
  /** Required fields the answerer has already refused once — asking again cannot help. */
  const repeated: string[] = [];
  for (const field of wanted) {
    ctx.guards.pendingFields.add(field.label);
    ctx.guards.rememberField(field);
  }
  /**
   * A control that would not take the value. Recorded against the field, not
   * the candidate: after the second attempt it stops being something to retry
   * and stops being something anyone can be asked about.
   */
  const recordFailure = (label: string, message: string) => {
    const { exhausted } = ctx.guards.recordFillFailure(label, message);
    (exhausted ? blocked : failed).push(`${label}: ${message}`);
  };

  for (const answer of answers) {
    const field = wanted.find((candidate) => candidate.ref === answer.ref);
    if (!field) continue;

    // The answer model sees the field together with the job and can distinguish
    // an application question from a site search box or misread section title.
    // Only genuine application questions may become candidate tasks.
    if (answer.applicationQuestion === false) {
      ctx.guards.pendingFields.delete(field.label);
      ctx.guards.resolveGrounding(field.label);
      unrelated.push(field.label);
      continue;
    }

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
      ctx.guards.rememberField(
        field,
        answer.candidatePrompt?.trim() || field.description?.trim() || `What should Owtomate enter for “${field.label}”?`,
      );
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
          recordFailure(field.label, (secondError as Error).message);
          continue;
        }
      } else {
        recordFailure(field.label, (error as Error).message);
        continue;
      }
    }
    ctx.guards.recordFillSuccess(field.label);
    const prior = ctx.captured.findIndex(item => item.question === field.label);
    if (prior >= 0) ctx.captured.splice(prior, 1);
    ctx.captured.push({ question: field.label, answer: value });
    filled.push(`${field.label} → ${value.slice(0, 60)}`);
  }

  if (filled.length) ctx.guards.recordProgress();
  const ungroundedNow = ctx.guards.ungrounded.length;
  return ok(
    unusableNote +
    (failed.length ? `Not accepted; re-observe and recover:\n${failed.join("\n")}\n` : '') +
    (blocked.length
      ? `This form refused these twice, so they are settled — do not answer them again:\n${blocked.join('\n')}\n`
      : '') +
    `Verified ${filled.length} field(s):\n${filled.map((line) => `  - ${line}`).join('\n')}` +
      (skipped.length ? `\nLeft blank (optional, nothing in the profile supports an answer): ${skipped.join('; ')}` : '') +
      (unrelated.length ? `\nIgnored controls that are not application questions: ${unrelated.join('; ')}` : '') +
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

  /**
   * Written now, with a box in front of us, and not before.
   *
   * Letters used to be drafted as every application opened, in parallel, to
   * save the few seconds a draft takes. Most forms have no cover-letter box —
   * Indeed's never does — so six in ten drafts were thrown away, and the
   * letter model is the largest part of what an application costs. Drafting
   * and polishing are both cached per job, so a retry does not pay twice.
   */
  const letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');

  await textarea.fill(letter, { timeout: 10_000 });
  if (await textarea.inputValue() !== letter) throw new Error('Cover letter did not retain the drafted text');
  ctx.coverLetter = letter;
  if (config.coverLetter.mode === 'reuse') ctx.log('  ↻ reusable cover letter selected');
  return ok(
    `Cover letter written (${letter.split(/\s+/).length} words), addressed to ${ctx.job.company}. ` +
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
      if (outcome.status === 'uploaded') {
        const site = hostOf(ctx.page.url());
        noteAction(ctx, { kind: 'resume-uploaded', site, detail: `Added "${outcome.name}" to your documents on ${siteName(site)}.` });
      }
      return ok(`Resume "${outcome.name}" ${outcome.status}. Move on to the next step.`);
    case 'unavailable':
      if (outcome.reason === 'upload-failed') {
        return {
          kind: 'terminal',
          outcome: { status: 'skipped', reason: 'The résumé could not be attached to this application.' },
        };
      }
      if (outcome.reason === 'local-file-missing') {
        return ok(
          `The selected resume ("${outcome.wanted}") is missing from local storage and cannot be attached. ` +
            'Finish with "cannot_complete".',
        );
      }
      if (outcome.reason === 'upload-control-missing') {
        return ok(
          `The selected resume ("${outcome.wanted}") is not on this account, and this application offers nowhere to upload it. ` +
            `Available: ${outcome.available.join(', ') || 'none'}. Finish with "cannot_complete".`,
        );
      }
      return ok(
        `The resume for this run ("${outcome.wanted}") is not on the account and uploading is disabled. ` +
          `Available: ${outcome.available.join(', ') || 'none'}. Finish with "cannot_complete".`,
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
       * the page never showed a confirmation, so this attempt is skipped.
       */
      return {
        kind: 'terminal',
        outcome: {
          status: 'skipped',
          reason: 'The application was not confirmed as submitted.',
        },
      };
    case 'off_platform':
      /**
       * "Continues elsewhere" is a claim about where the page is, and the
       * URL settles it. Indeed's wizard has thrown an application back to
       * the Indeed homepage mid-flow; that is the board closing the form,
       * not the employer taking over, and it belongs in Needs attention.
       */
      if (!isExternal(ctx.page.url())) {
        return {
          kind: 'terminal',
          outcome: { status: 'needs-human', reason: 'The job board closed the application form before it was finished.' },
        };
      }
      return { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } };
    case 'already_applied':
      return { kind: 'terminal', outcome: { status: 'already-applied', reason } };
    case 'nothing_to_apply_to':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    case 'cannot_complete':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    default:
      // The agent met a challenge. With a solver on, one attempt is made;
      // if it clears, the agent carries on.
      if (/captcha|robot|verify you are human|bot check|security verification/i.test(reason) && captchaEnabled()) {
        if (await trySolveCaptcha(ctx.page)) return ok('The challenge was cleared. Re-observe the page and continue.');
      }
      return ctx.guards.pendingFields.size || ctx.guards.ungrounded.length
        ? { kind: 'terminal', outcome: { status: 'needs-human', reason } }
        : { kind: 'terminal', outcome: { status: 'skipped', reason } };
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
  if (under.href && isAustralianGovernmentUrl(under.href)) {
    return {
      kind: 'terminal',
      outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
    };
  }
  if (under.href && isForbiddenDestination(under.href)) {
    return ok(`Refused: that point is a link to ${under.href}, which this tool never navigates to.`);
  }
  if (isSubmitAction(under.text) && !isEntryAction(under.text, { captured: ctx.captured.length, fields: ctx.observation.fields.length })) {
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
    return ok('No mailbox is signed in for this candidate. Try another authentication option; otherwise finish with "cannot_complete".');
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
    if (/signed out/i.test(found.error)) return ok(`${found.error} Try another authentication option; otherwise finish with "cannot_complete".`);
    return ok('No verification email arrived within 90 seconds. If the page has a resend control, click it and call this again once; otherwise finish with "cannot_complete".');
  }

  await fillField(ctx.page, field, found.code);
  ctx.guards.recordProgress();
  ctx.log(`  ✉ entered the code from "${found.subject.slice(0, 60)}"`);
  {
    const site = hostOf(ctx.page.url());
    noteAction(ctx, {
      kind: 'email-code',
      site,
      detail: `Used the verification code ${siteName(site)} emailed you ("${found.subject.slice(0, 60)}").`,
    });
  }
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
    case 'complete_authentication':
      return doCompleteAuthentication(ctx, args);
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
