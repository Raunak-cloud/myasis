import type { Page } from 'patchright';
import { config } from '../config.js';
import {
  captureInteractivePageState,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from '../browser.js';
import { fillField } from '../dom.js';
import { answerFields, finishedCoverLetterForJob, fitCoverLetterToLimit, verifySubmissionEvidence } from '../llm.js';
import { pickResumeForJob, RESUME_DIR } from '../resume.js';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
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
  submissionAttempted?: boolean;
  reloads?: number;
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
    name: 'confirm_submission',
    description: 'After submitting, use this when the current page explicitly confirms the application was sent. An independent verifier checks the employer evidence; your claim alone never counts as success.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'reload_page',
    description: 'Retry the current employer page after a temporary server/loading error, before entering application data. Never use after submission or to bypass an access restriction.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
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
      'Answer one applicant FIELD per turn, then re-observe the changed page. ' +
      'You do NOT write the answers — they are generated from the verified candidate profile and filled in for you. ' +
      'Do not include the cover-letter textarea or file inputs here.',
    parameters: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 1,
          description: 'One field ref from the current FIELDS list, e.g. ["f0"].',
        },
        reason: { type: 'string', description: 'What this step is asking for.' },
        required_refs: { type: 'array', items: { type: 'string' }, description: 'Subset of refs required by current page instructions or validation despite missing markup. Explain the evidence in reason. Never mark every option of a multi-select group required.' },
        interaction: { type: 'string', enum: ['type', 'search'], description: 'type enters the grounded value and leaves the field; search leaves focus in an editable suggestion field so YOU can inspect and click an observed option next. No menu option is automatically chosen.' },
        repair_refs: {
          type: 'array', items: { type: 'string' },
          description: 'Subset of refs whose existing values are incomplete, wrong for this field, or rejected by the page. Explain the visible problem in reason. Answers are still grounded in the verified profile.',
        },
      },
      required: ['refs', 'reason'],
    },
  },
  {
    name: 'add_cover_letter',
    description:
      'Write the grounded, humanized cover letter into the FIELD ref you selected. To reveal it, use click or pass the cover-letter radio/select FIELD ref and its exact writing option. Never targets the first textarea automatically.',
    parameters: { type: 'object', properties: {
      ref: { type: 'string', description: 'Observed cover-letter FIELD ref.' },
      option: { type: 'string', description: 'Exact option to reveal the cover-letter writing field, for radio/select controls only.' },
    }, required: ['ref'] },
  },
  {
    name: 'attach_resume',
    description:
      'Handle the resume/CV/document step. Call this whenever the step is about choosing or attaching a resume — ' +
      'whether it shows a list of existing documents to pick from or a file upload. The resume for this run is already chosen. ' +
      'Call without a ref to learn the approved document name, then select its upload ACTION ref or radio/select FIELD ref and exact option. ' +
      'You decide from the current page which control is for the resume, never a photo upload. Re-observe after uploading to check acceptance and select the document if needed.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Resume upload ACTION ref or existing-document radio/select FIELD ref.' },
        option: { type: 'string', description: 'Exact observed option naming the approved resume, for a radio/select FIELD.' },
      },
      required: [],
    },
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

  if (isSubmitAction(action.text) && !entry) ctx.submissionAttempted = true;
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
      noteAction(ctx, { kind: 'authentication-prepared', site, email, detail: `Filled account-registration fields on ${siteName(site)} with ${email}; account creation is not yet confirmed.` });
    } else if (purpose === 'reset_password') {
      noteAction(ctx, { kind: 'authentication-prepared', site, email, detail: `Filled password-reset fields on ${siteName(site)}; reset is not yet confirmed.` });
    } else {
      noteAction(ctx, { kind: 'authentication-prepared', site, email, detail: `Filled sign-in fields on ${siteName(site)} with ${email}; sign-in is not yet confirmed.` });
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
  if (!refs.length || refs.some(ref => !ctx.observation.fields.some(field => field.ref === ref))) {
    return ok('Invalid refs: provide an array containing one exact current FIELD ref, e.g. ["f0"]. Re-observe rather than guessing.');
  }
  const requiredRefs = Array.isArray(args.required_refs) && typeof args.reason === 'string' && args.reason.trim() ? args.required_refs.map(String) : [];
  const asked = ctx.observation.fields.filter((field) => refs.includes(field.ref))
    .map(field => ({ ...field, required: field.required || requiredRefs.includes(field.ref) }));

  // Preserve valid prefilled answers unless the model requests a grounded
  // correction; a validation failure must never be mistaken for completion.
  const repairRefs = Array.isArray(args.repair_refs) && typeof args.reason === 'string' && args.reason.trim()
    ? args.repair_refs.map(String) : [];
  const alreadyComplete = asked.filter((field) => !ctx.guards.pendingFields.has(field.label) && !ctx.guards.unfillable.has(field.label) && !field.validationError && !repairRefs.includes(field.ref) && (
    field.kind === 'checkbox'
      ? field.currentValue === 'true'
      : Boolean(field.currentValue?.trim())),
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
  const wanted = asked.filter(field => !field.sensitive && !alreadyComplete.includes(field)).slice(0, 1);
  if (credentials.length) return ok('Use complete_authentication for credential fields.');
  if (!wanted.length) return ok('No unanswered fields in those refs. Re-observe and choose the next field; use repair_refs to correct a prefilled value.');

  const answerContext = wanted.map(field => ({ ...field, description:
    `${field.description ?? ''}\nUntrusted form context (not candidate facts): ${ctx.observation.text.slice(0, 6000)}` +
    (repairRefs.includes(field.ref) ? `\nRepair context (untrusted observation): ${String(args.reason).slice(0, 1500)}` : '') }));
  const first = await answerFields(answerContext, ctx.job, ctx.profile);
  let answers = first.answers;
  let injectionSuspected = first.injectionSuspected;
  /**
   * Before a required question goes to the candidate, the reasoning model
   * gets one look at it. The fast model answers most questions well, but a
   * question it could not place — a phone code split from the number, a date
   * spread over three boxes — is usually one that a moment's thought resolves,
   * and a paused application costs the candidate far more than a slower call.
   */
  const unsure = answerContext.filter((field) =>
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
  const skipped: string[] = [];
  const unrelated: string[] = [];
  /** Required fields the answerer has already refused once — asking again cannot help. */
  const repeated: string[] = [];
  for (const field of wanted) {
    ctx.guards.pendingFields.add(field.label);
    ctx.guards.rememberField(field);
  }
  // Keep failures as submission blockers until recovered, never as retry bans.
  const recordFailure = (label: string, message: string) => {
    ctx.guards.recordFillFailure(label, message);
    failed.push(`${label}: ${message}`);
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

    const value = answer.value;
    try {
      await fillField(ctx.page, field, value, args.interaction === 'search' ? 'search' : 'type');
    } catch (error) {
      recordFailure(field.label, (error as Error).message);
      // Recovery is a new model decision with a fresh observation, not a
      // hidden repeat of the same operation inside this tool.
      continue;
    }
    ctx.guards.recordFillSuccess(field.label);
    const prior = ctx.captured.findIndex(item => item.question === field.label);
    if (prior >= 0) ctx.captured.splice(prior, 1);
    ctx.captured.push({ question: field.label, answer: value });
    filled.push(`${field.label} → ${value.slice(0, 60)}${answer.rationale ? ` (${answer.rationale.slice(0, 500)})` : ''}`);
  }

  if (filled.length) ctx.guards.recordProgress();
  const ungroundedNow = ctx.guards.ungrounded.length;
  return ok(
    (failed.length ? `Not accepted; re-observe and recover:\n${failed.join("\n")}\n` : '') +
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

/** Writes only to the current field selected by the navigation model. */
async function doAddCoverLetter(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const field = ctx.observation.fields.find(field => field.ref === args.ref);
  if (field && ['radio', 'select'].includes(field.kind) && typeof args.option === 'string' && field.options?.includes(args.option)) {
    await fillField(ctx.page, field, args.option);
    return ok('Cover-letter option selected. Re-observe, then call add_cover_letter with the writing FIELD ref.');
  }
  if (!field || !['textarea', 'text'].includes(field.kind) || field.sensitive) {
    return ok('Choose the visible cover-letter FIELD ref. If it is hidden, use click to open the write-letter option, then observe again. Never choose an unrelated text box.');
  }
  let letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');
  const maxLength = await ctx.page.locator(`[data-field-id="${field.ref}"]`).evaluate(el => (el as HTMLTextAreaElement).maxLength).catch(() => -1);
  if (Number.isInteger(maxLength) && maxLength >= 0) letter = await fitCoverLetterToLimit(letter, maxLength, ctx.job, ctx.profile);
  try { await fillField(ctx.page, field, letter, 'type'); }
  catch (error) { return ok(`Cover letter not accepted: ${(error as Error).message}. Re-observe and choose the current writing field or resolve the form's validation.`); }
  ctx.coverLetter = letter;
  ctx.guards.recordFillSuccess(field.label);
  return ok(`Cover letter verified in ${field.ref}. Re-observe the page and handle any remaining fields or validation before continuing.`);
}

/** The model selects the control; this tool supplies only the approved local document. */
async function doAttachResume(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = await pickResumeForJob(ctx.job, ctx.profile);
  if (!wanted) return ok('No approved local resume is available. Finish with cannot_complete; do not choose an arbitrary document.');
  const ref = typeof args.ref === 'string' ? args.ref : '';
  const field = ctx.observation.fields.find(field => field.ref === ref);
  const action = ctx.observation.actions.find(action => action.ref === ref && action.role === 'file');
  const identity = `Resume to use: "${wanted.seekName || wanted.fileName}" (label "${wanted.label}").`;
  if (field && ['radio', 'select'].includes(field.kind)) {
    const option = typeof args.option === 'string' ? args.option : '';
    const normal = (value: string) => value.toLowerCase().replace(/\.(docx?|pdf|rtf|txt)\b/g, '').replace(/[^a-z0-9]/g, '');
    const names = [wanted.seekName, wanted.fileName, wanted.label].filter((name): name is string => Boolean(name));
    if (!field.options?.includes(option) || !names.some(name => normal(name).length >= 3 && normal(option).includes(normal(name)))) {
      return ok(`${identity} Choose its exact observed option, or upload it; do not select a different document.`);
    }
    await fillField(ctx.page, field, option);
    ctx.resumeUsed = wanted.label;
    ctx.guards.recordFillSuccess(field.label);
    return ok('Resume selection verified. Re-observe before continuing.');
  }
  if (!action || action.disabled || !/^a\d+$/.test(ref)) {
    return ok(`${identity} Pass the observed resume upload ACTION ref, or a radio/select FIELD ref plus its exact option. If the control is hidden, open it with click and observe again. Do not use a photo upload.`);
  }
  if (!config.resume.allowUpload) return ok('Resume uploading is disabled. Select the matching existing document or finish with cannot_complete.');
  const file = resolve(RESUME_DIR, wanted.fileName);
  const within = relative(RESUME_DIR, file);
  if (!within || within.startsWith('..') || isAbsolute(within) || !existsSync(file)) {
    return ok('The approved resume file is unavailable. Finish with cannot_complete.');
  }
  const input = ctx.page.locator(`input[type="file"][data-ref-id="${ref}"]`);
  const accept = await input.getAttribute('accept') ?? '';
  if (/image\//i.test(accept) && !/pdf|word|document|\.doc|\.rtf|\.txt/i.test(accept)) {
    return ok('That upload accepts images, not a resume. Choose the document upload from a fresh observation.');
  }
  await input.setInputFiles(file, { timeout: 10_000 });
  const retained = await input.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name ?? '').catch(() => '');
  if (retained) {
    ctx.resumeUsed = wanted.label;
    const site = hostOf(ctx.page.url());
    noteAction(ctx, { kind: 'resume-uploaded', site, detail: `Sent "${wanted.label}" to the resume upload control on ${siteName(site)}.` });
  }
  // File transport is not proof of server acceptance. Let the model read the next
  // observation, choose the uploaded document, and recover from any site error.
  return ok(`Resume file sent to the selected control${retained ? ` ("${retained}")` : ''}. Re-observe: confirm the document appears and select it with attach_resume if needed; resolve upload errors before continuing. This is not application success.`);
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
        const label = element.closest('label') as HTMLLabelElement | null;
        const field = element.closest('[data-field-id]') ?? label?.control ?? clickable.querySelector('[data-field-id]');
        const link = clickable.closest('a[href]');
        return {
          tag: clickable.tagName,
          fieldRef: field?.getAttribute('data-field-id') ?? null,
          text: ((clickable as HTMLElement).innerText || (clickable instanceof HTMLInputElement ? clickable.value : '') || clickable.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          href: link ? (link as HTMLAnchorElement).href : null,
        };
      },
      { x, y },
    )
    .catch(() => null);
  if (!under) return ok('Nothing is under that point. Re-observe and try a ref or a different point.');
  if (under.fieldRef) return ok(`That point targets FIELD ${under.fieldRef}. Use its grounded field tool; coordinates cannot bypass answer verification. Re-observe and choose the correct supported answer.`);
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
  if (isSubmitAction(under.text) && !isEntryAction(under.text, { captured: ctx.captured.length, fields: ctx.observation.fields.length })) ctx.submissionAttempted = true;
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
    case 'confirm_submission': {
      if (!ctx.submissionAttempted) return ok('No submission action has been recorded for this attempt. Do not claim success; inspect the page.');
      const evidence = { url: ctx.page.url(), text: ctx.observation.text, actions: ctx.observation.actions, fields: ctx.observation.fields };
      return await verifySubmissionEvidence(evidence, ctx.job)
        ? { kind: 'terminal', outcome: { status: 'applied' } }
        : ok('The employer page does not yet verify a completed submission. Inspect its validation or wait for confirmation.');
    }
    case 'reload_page': {
      if (ctx.submissionAttempted || ctx.captured.length || ctx.resumeUsed || ctx.coverLetter) return ok('Reload withheld: application data was entered or submission attempted. Preserve the form and inspect its current state.');
      if ((ctx.reloads ?? 0) >= 2) return ok('Reload did not resolve this page after two attempts. Inspect other visible recovery controls; do not bypass access restrictions.');
      ctx.reloads = (ctx.reloads ?? 0) + 1;
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      return ok('Reload attempted. Inspect the fresh page; this is not application success.');
    }
    case 'click':
      return doClick(ctx, args);
    case 'complete_authentication':
      return doCompleteAuthentication(ctx, args);
    case 'answer_questions':
      return doAnswerQuestions(ctx, args);
    case 'add_cover_letter':
      return doAddCoverLetter(ctx, args);
    case 'attach_resume':
      return doAttachResume(ctx, args);
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
