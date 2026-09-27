import type { Page } from 'patchright';
import { config } from '../config.js';
import {
  captureInteractivePageState,
  jitter,
  waitForInteractivePageChange,
  waitForInteractiveSurface,
} from '../browser.js';
import { fillField, setChecked } from '../dom.js';
import { answerFields, auditFormBeforeSubmit, finishedCoverLetterForJob, fitCoverLetterToLimit, isRequiredConsent, isSubmitControl, verifySubmissionEvidence } from '../llm.js';
import { acceptsFormat, pickResumeForJob, RESUME_DIR, documentFor } from '../resume.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import type { ApplicationAction, BlockedQuestion, CandidateProfile, FormField, JobListing } from '../types.js';
import type { Observation } from './observe.js';
import { RunGuards, isEntryAction, isExternal, isForbiddenDestination, isSubmitAction } from './guards.js';
import type { ToolSchema } from './celeris.js';
import { handleCaptchaWithCapMonster } from '../captcha.js';
import { wasHumanized } from '../humanizer.js';
import { countHealth } from '../run-health.js';
import { browserGmailAvailable, findVerificationInBrowser } from '../browser-gmail.js';
import { authenticationValue, hostOf } from '../site-auth.js';
import { isAustralianGovernmentUrl } from '../site-policy.js';
import { offersCoverLetter } from './cover-letter-opportunity.js';
import { RAW_TOOL_SCHEMAS, locate, pressWatched, runRawTool } from './raw-tools.js';

/**
 * The agent's entire action surface.
 *
 * Two rules shape every tool here:
 *
 * 1. Actions are addressed by `ref` — a token this run stamped onto a real,
 *    visible element during the last observation, or one from an
 *    accessibility snapshot. The general browser tools in raw-tools.ts (a
 *    snapshot across iframes, scripts, navigation, tabs) cover whatever the
 *    purpose-built ones cannot reach, and pass the same gates.
 * 2. The model chooses *which* control to act on. It does not author the
 *    candidate's answers: they come from the grounded answer path, which
 *    refuses to invent facts, and a form touched by the general tools is
 *    audited against the candidate's record before it is sent.
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
  /** Set only after a real cover-letter input or reveal control was observed. */
  coverLetterOffered?: boolean;
  resumeUsed?: string;
  log: (line: string) => void;
  /** Side effects the candidate must be told about — see `ApplicationAction`. */
  actions: ApplicationAction[];
  submissionAttempted?: boolean;
  reloads?: number;
  /** Caption of the list-opening control clicked last, for options that do not name their question. */
  lastListQuestion?: string;
  /** The browser tools changed the form outside the grounded answer tools, so it is audited before sending. */
  rawUsed?: boolean;
  /** This tool call already passed the submit gate; the network backstop lets its form post through. */
  submitCleared?: boolean;
  /** This tool call's press was judged by the gate (submit or not), so its form post needs no second judgment. */
  pressJudged?: boolean;
  auditFailures?: number;
  /** Times the pre-submit audit flagged each field. */
  auditStrikes?: Map<string, number>;
  /** Sets of values the page already held that were checked and found to be the candidate's. */
  prefilledAudited?: Set<string>;
  /** What the last tool call did, for judging a dialog it raised. */
  lastActionLabel?: string;
  /** Browser dialogs answered since the last turn, reported to the agent. */
  dialogs?: string[];
  /** The agent asked to see the page; the next observation carries a screenshot. */
  wantScreenshot?: boolean;
  /** Recent failed requests and console errors, per tab, for get_diagnostics. */
  diagnostics?: WeakMap<Page, string[]>;
}

const ok = (message: string): ToolResult => ({ kind: 'ok', message });

/**
 * Remember only actionable cover-letter UI, never wording in a job advert.
 * This lets the submit gate enforce the plan promise without blocking an
 * employer that simply did not include a place to receive a letter.
 */
function rememberCoverLetterOpportunity(ctx: ToolContext): void {
  if (ctx.coverLetterOffered) return;
  ctx.coverLetterOffered = offersCoverLetter(ctx.observation);
}

const advancesApplication = (text: string): boolean =>
  /^(continue|next|review(?: your)? application|preview application|save and continue)$/i.test(text.trim()) ||
  isSubmitAction(text);

/**
 * What the page shows after a submit, for the independent verifier.
 *
 * The observation's text is the start of the main region, capped for the
 * agent's prompt; an employer that prints "Your application has been
 * submitted" under a long job ad and the form was outside it, so a real
 * submission read as unconfirmed and the agent pressed Submit again. The
 * verifier gets the whole page's beginning and end instead.
 */
async function submissionEvidence(ctx: ToolContext): Promise<{ url: string; text: string; actions: unknown[]; fields: unknown[] }> {
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
  if (isSubmitAction(label)) return true;
  if (!label.trim() || /\(opens a list\)$/.test(label)) return false;
  // Nothing typed, attached or on the page: there is nothing a click could send.
  if (!ctx.captured.length && !ctx.resumeUsed && !ctx.coverLetter && !ctx.observation.fields.length) return false;
  let key = label;
  try {
    const url = new URL(ctx.page.url());
    key = `${url.host}${url.pathname}|${label}`;
  } catch {}
  const known = submitVerdicts.get(key);
  if (known !== undefined) return known;
  const verdict = await isSubmitControl(
    { label, context },
    { url: ctx.page.url(), title: ctx.observation.title, text: ctx.observation.text, fields: ctx.observation.fields.length, entered: ctx.captured.length },
  ).catch(() => true);
  submitVerdicts.set(key, verdict);
  if (verdict) ctx.log(`  · "${label.slice(0, 60)}" read as the final submit`);
  return verdict;
}

type Gate = { proceed: true; submit: boolean } | { proceed: false; result: ToolResult };

/**
 * The checks every press of a control passes, whichever tool presses it — a
 * listed action, a point on the screenshot, a snapshot element, the Enter key,
 * a script, or a form post caught on the network. One gate, so a new way to
 * act cannot become a new way around the rules:
 *
 * - a cover letter the employer offers is written before the form advances;
 * - a control that sends the application passes `canSubmit`, which reads
 *   configuration and recorded facts only (dry run, unanswered questions);
 * - a second submit is pressed only once the first is known not to have gone
 *   through, since some forms confirm in place and pressing again sends the
 *   employer another copy;
 * - a form the agent filled with its own browser tools is audited first.
 */
export async function gateAdvance(
  ctx: ToolContext,
  label: string,
  context?: string,
  options: { role?: string; knownSubmit?: boolean } = {},
): Promise<Gate> {
  // Free accounts send the grounded draft; eligible paid/admin accounts the
  // humanized version from finishedCoverLetterForJob().
  if (advancesApplication(label) && ctx.coverLetterOffered && !ctx.coverLetter) {
    return { proceed: false, result: ok(
      'Do not advance yet: this application offers a cover letter and none has been verified. ' +
      'Reveal its writing field if needed, then call add_cover_letter with that FIELD ref.',
    ) };
  }
  const entry = !options.knownSubmit && isEntryAction(label, { captured: ctx.captured.length, fields: ctx.observation.fields.length });
  if (entry) ctx.log(`  → opening the application: "${label}"`);
  if (!entry && (options.knownSubmit || advancesApplication(label))) {
    const held = await auditPrefilled(ctx);
    if (held) return { proceed: false, result: held };
  }
  const submit = options.knownSubmit === true
    || (!entry && options.role !== 'toggle' && options.role !== 'file' && await transmits(ctx, label, context));
  ctx.pressJudged = true;
  if (!submit) return { proceed: true, submit: false };

  if (ctx.submissionAttempted && await verifySubmissionEvidence(await submissionEvidence(ctx), ctx.job).catch(() => false)) {
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'applied' } } };
  }
  const verdict = ctx.guards.canSubmit(ctx.page.url());
  if (!verdict.allowed && verdict.kind !== 'dry-run') {
    if (verdict.kind === 'off-platform') {
      return { proceed: false, result: { kind: 'terminal', outcome: { status: 'off-platform', redirectedTo: ctx.page.url() } } };
    }
    if (!ctx.guards.ungrounded.length) {
      return { proceed: false, result: ok(`Submission withheld: ${verdict.reason}. Re-observe and repair the unconfirmed fields; this is a recoverable form issue, not a missing candidate answer.`) };
    }
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'needs-human', reason: verdict.reason, detail: verdict.detail } } };
  }
  const audit = await auditBeforeSubmit(ctx);
  if (audit) return { proceed: false, result: audit };
  if (!verdict.allowed) {
    ctx.log(`  ✋ dry run — withheld "${label}"`);
    return { proceed: false, result: { kind: 'terminal', outcome: { status: 'rehearsed', stoppedAt: ctx.page.url() } } };
  }
  ctx.log(`  → submitting: "${label}"`);
  ctx.submissionAttempted = true;
  ctx.submitCleared = true;
  return { proceed: true, submit: true };
}

/** A form element's accessibility tree without the per-element bookkeeping, for a reader rather than a clicker. */
const readableSnapshot = (snapshot: string) => snapshot.replace(/ \[(?:ref|cursor)=[^\]]*\]/g, '');

/**
 * Before a form the agent filled with its own browser tools is sent, every
 * answer on it is checked against the candidate's record — the result, not
 * the route, since a script or a raw keystroke leaves no grounded trail.
 * Returns what to tell the agent instead of sending, or null to go ahead.
 *
 * An answer flagged a second time becomes a question for the candidate: the
 * agent has had its chance to correct it and the form must not go out wrong.
 * An audit that cannot run holds the submit rather than waving it through.
 */
async function auditBeforeSubmit(ctx: ToolContext): Promise<ToolResult | null> {
  if (!ctx.rawUsed) return null;
  const snapshot = await ctx.page.ariaSnapshot({ mode: 'ai', timeout: 15_000 }).catch(() => '');
  let problems: Awaited<ReturnType<typeof auditFormBeforeSubmit>>;
  try {
    if (!snapshot) throw new Error('the page could not be read');
    problems = await auditFormBeforeSubmit(readableSnapshot(snapshot), ctx.job, ctx.profile, ctx.captured);
  } catch (error) {
    ctx.auditFailures = (ctx.auditFailures ?? 0) + 1;
    ctx.log(`  · pre-submit check unavailable: ${(error as Error).message.slice(0, 120)}`);
    if (ctx.auditFailures >= 2) {
      return { kind: 'terminal', outcome: { status: 'skipped', reason: 'The answers could not be checked before sending.' } };
    }
    return ok('The pre-submit answer check could not run. Wait a moment, re-observe, and press the submit control again.');
  }
  return withheldFor(ctx, problems);
}

/**
 * Answers the page already held when the agent arrived — an employer's saved
 * draft, an account's autofill — are checked before the page is left.
 *
 * The agent's own answers are grounded as it gives them; these were never
 * grounded by anyone. Tabcorp's PageUp draft kept "Base salary: $350k+" from
 * an earlier attempt, and the agent moved on because the field was "already
 * filled". Checked once per distinct set of values, on the page that shows
 * them, since a later page (or a review step) may never show them again.
 */
async function auditPrefilled(ctx: ToolContext): Promise<ToolResult | null> {
  const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const entered = new Set(ctx.captured.map((item) => normal(item.question)));
  const prefilled = ctx.observation.fields.filter((field) =>
    field.kind !== 'checkbox' && !field.sensitive && field.currentValue?.trim() && !entered.has(normal(field.label)));
  if (!prefilled.length) return null;
  const signature = prefilled.map((field) => `${field.label}=${field.currentValue}`).join('\n');
  const audited = (ctx.prefilledAudited ??= new Set<string>());
  if (audited.has(signature)) return null;
  let problems: Awaited<ReturnType<typeof auditFormBeforeSubmit>>;
  try {
    problems = await auditFormBeforeSubmit(
      `Fields on this page that already held these answers before the agent touched them:\n${prefilled.map((field) => `- ${field.label}: ${field.currentValue}`).join('\n')}`,
      ctx.job, ctx.profile, ctx.captured,
    );
  } catch (error) {
    // Not a reason to stop: the agent's own answers were grounded, and the submit audit still runs.
    ctx.log(`  · pre-filled answer check unavailable: ${(error as Error).message.slice(0, 120)}`);
    return null;
  }
  if (!problems.length) {
    audited.add(signature);
    return null;
  }
  return withheldFor(ctx, problems);
}

/** What the agent is told when answers on the form are not the candidate's; a field flagged twice goes to the candidate. */
function withheldFor(ctx: ToolContext, problems: Array<{ field: string; value: string; problem: string }>): ToolResult | null {
  if (!problems.length) return null;
  const strikes = (ctx.auditStrikes ??= new Map<string, number>());
  for (const problem of problems) {
    const count = (strikes.get(problem.field) ?? 0) + 1;
    strikes.set(problem.field, count);
    if (count >= 2) {
      ctx.guards.rememberField({ label: problem.field }, `What should Owtomate enter for “${problem.field}”?`);
      ctx.guards.recordUngrounded(problem.field);
    }
  }
  ctx.log(`  ✋ pre-submit check: ${problems.length} unsupported answer(s): ${problems.map((p) => p.field).join('; ').slice(0, 200)}`);
  if (ctx.guards.ungrounded.length) {
    return { kind: 'terminal', outcome: {
      status: 'needs-human',
      reason: `These answers are not supported by your profile: ${ctx.guards.ungrounded.slice(0, 3).join('; ')}`,
      detail: problems.map((p) => `${p.field}: ${p.problem}`).join('; '),
    } };
  }
  return ok(
    `Not sent on: these answers are not supported by the candidate's record:\n` +
    problems.map((p) => `- ${p.field}: "${p.value.slice(0, 80)}" — ${p.problem}`).join('\n') +
    '\nCorrect each one with answer_questions (a value the page already held goes in repair_refs, with your reason), ' +
    'or fill_element without a value for a field only the snapshot shows (both answer from the verified record), ' +
    'then press the same control again.',
  );
}

/** Records a side effect once per kind and site, and says so in the run log. */
function noteAction(ctx: ToolContext, action: Omit<ApplicationAction, 'at'>): void {
  if (ctx.actions.some((known) => known.kind === action.kind && known.site === action.site && known.purpose === action.purpose)) return;
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
    'inbox and typed into that field for you. For separate digit boxes, supply refs in visual reading order instead of ref. Never type a code yourself.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'The FIELD ref of the code input.' },
      refs: { type: 'array', items: { type: 'string' }, description: 'All code FIELD refs in digit order when the code has separate boxes.' },
      sender_hint: { type: 'string', description: 'The site or company that sent the code, e.g. "Oracle" or "Workday".' },
    },
    required: [],
  },
};

const EMAILED_LINK_TOOL: ToolSchema = {
  name: 'open_emailed_link',
  description:
    'When the page says a verification, activation, confirmation or password-reset LINK was emailed to the candidate ' +
    '(for example "check your email to verify your account"), call this after the email has been requested. The link is read ' +
    "from the candidate's inbox and opened in a new tab, where the application continues. Never guess or type a link.",
  parameters: {
    type: 'object',
    properties: { sender_hint: { type: 'string', description: 'The site or company that sent the email, e.g. "Workday" or the employer.' } },
    required: [],
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
 * has connected, the general browser tools unless switched off, and pointing
 * only while a screenshot is in front of it.
 */
export function toolSchemas(options: { vision?: boolean } = {}): ToolSchema[] {
  return [
    ...TOOL_SCHEMAS,
    ...(browserGmailAvailable() ? [EMAILED_CODE_TOOL, EMAILED_LINK_TOOL] : []),
    ...(config.celeris.rawTools ? RAW_TOOL_SCHEMAS : []),
    ...(options.vision ? [CLICK_POINT_TOOL] : []),
  ];
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'choose_option',
    description: 'Choose from the currently open custom dropdown. Pass any current option ACTION ref; if its label lacks the dropdown question, also pass the originating FIELD ref. The grounded answer model selects and clicks the supported option. Never click option ACTIONS directly.',
    parameters: { type: 'object', properties: {
      ref: { type: 'string', description: 'A current option ACTION ref from the open dropdown.' },
      field_ref: { type: 'string', description: 'The originating FIELD ref when the option ACTION does not include its question.' },
    }, required: ['ref'] },
  },
  {
    name: 'accept_terms',
    description: 'Accept a required employer-site terms, privacy, consent or acknowledgement checkbox. Prefer its current FIELD or ACTION ref; when the screenshot is the only representation, pass x and y on the same 0-1000 grid as click_point. The tool verifies the target and refuses unrelated answers or marketing choices.',
    parameters: { type: 'object', properties: {
      ref: { type: 'string', description: 'Current FIELD or ACTION ref for the required consent control.' },
      x: { type: 'number', description: 'Screenshot x coordinate, 0-1000, only when no ref exists.' },
      y: { type: 'number', description: 'Screenshot y coordinate, 0-1000, only when no ref exists.' },
    }, required: [] },
  },
  {
    name: 'wait_for_page',
    description: 'Wait up to 10 seconds for a loading page or pending request to change, without clicking or reloading. Use before recovery actions when the page is still loading. Existing run budgets still apply.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
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
      'Write the grounded, humanized cover letter into the FIELD ref you selected. To reveal it, use click or pass the cover-letter radio/select FIELD ref and its exact writing option. When the form only takes the letter as a file, pass the cover-letter upload ACTION ref ([file]) instead: the letter is sent as a document. A writing box inside an embedded form takes its take_snapshot ref (e.g. f3e62); it replaces any text already there. Never targets the first textarea automatically.',
    parameters: { type: 'object', properties: {
      ref: { type: 'string', description: 'Observed cover-letter FIELD ref, a take_snapshot ref for a writing box inside an embedded form, or its upload ACTION ref when the letter must be a file.' },
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
        format: { type: 'string', enum: ['pdf', 'docx', 'doc', 'rtf', 'txt'], description: 'File type to send, only when the page says which types it accepts or rejected the last upload\'s type. The resume is converted for you.' },
      },
      required: [],
    },
  },
  {
    name: 'press_key',
    description:
      'Press a key or combination, optionally after focusing a ref (observation or snapshot): ArrowDown/ArrowUp to open or move ' +
      'through a custom list or date picker, Escape to close an overlay or menu, Tab to leave a field so it validates, ' +
      "PageDown/PageUp to scroll an inner panel, Enter to confirm a highlighted suggestion, Control+A to select all of a field's text. " +
      'Enter in a form that would send the application passes the same checks as its submit control.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A key name (ArrowDown, Enter, Escape, Tab, Backspace, a, …) or a combination such as Control+A or Shift+Tab.' },
        ref: { type: 'string', description: 'Optional ref to focus first.' },
      },
      required: ['key'],
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
  if (action.role === 'option') return ok('Use choose_option with an option ref so the selected value is grounded in the candidate profile. Direct option clicks are refused.');
  if (action.disabled) {
    return ok(
      `"${action.text}" is disabled — the step is not satisfied yet. Answer the remaining required fields first.`,
    );
  }

  const gate = await gateAdvance(ctx, action.text, action.context, { role: action.role });
  if (!gate.proceed) return gate.result;
  const { submit } = gate;
  // A list opened from a button has no FIELD; its caption is the question its options answer.
  if (/\(opens a list\)$/.test(action.text) || /^Open /.test(action.text)) {
    ctx.lastListQuestion = action.text.replace(/\s*\(opens a list\)$/, '').replace(/^(Open|Select)\s+/i, '').trim();
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
      : submit
        ? `Clicked "${action.text}" but the form did not submit. A form that refuses to submit almost always shows a validation message beside an incomplete required field, often near the top: scroll up, re-observe, and answer or fix the field it names before trying again.`
        : `Clicked "${action.text}" but nothing on the page changed. It was probably not the control that advances this step — try a different one.`,
  );
}

async function doChooseOption(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const requested = ctx.observation.actions.find(action => action.ref === ref && action.role === 'option');
  const source = ctx.observation.fields.find(field => field.ref === String(args.field_ref ?? ''));
  // The question may also come from the ACTION that opened the list, named in field_ref or clicked last.
  const opener = ctx.observation.actions.find(action => action.ref === String(args.field_ref ?? '') && action.role !== 'option');
  const openerQuestion = opener ? opener.text.replace(/\s*\(opens a list\)$/, '').replace(/^(Open|Select)\s+/i, '').trim() : ctx.lastListQuestion;
  if (!requested?.value || (!requested.question && !source && !openerQuestion)) return ok('Choose a current option ACTION; when its question is not included, also pass the originating FIELD ref (or the ACTION that opened the list) as field_ref.');
  const question = requested.question ?? source?.label ?? openerQuestion!;
  const group = ctx.observation.actions.filter(action => action.role === 'option' && action.value
    && !/^(select|choose)( one)?$/i.test(action.value.trim())
    && (requested.question ? action.question === requested.question : !action.question));
  if (!group.length) return ok('No current options are available for that dropdown. Re-open it and inspect the fresh page.');
  const field: FormField = {
    ref,
    label: question,
    kind: 'select',
    required: Boolean(source?.required) || /(^|\s)\*|\*\s*$/.test(question),
    options: group.map(action => action.value!),
    currentValue: '',
  };
  ctx.guards.pendingFields.add(field.label);
  ctx.guards.rememberField(field);
  const context = [{ ...field, description: `Choose one observed option. Untrusted form context (not candidate facts): ${ctx.observation.text.slice(0, 6000)}` }];
  let answer = (await answerFields(context, ctx.job, ctx.profile)).answers.find(candidate => candidate.ref === ref);
  if (field.required && answer?.applicationQuestion !== false && !answer?.grounded) {
    ctx.log('  ↑ thinking again about 1 dropdown before asking the candidate');
    const reasoned = await answerFields(context, ctx.job, ctx.profile).catch(() => null);
    const better = reasoned?.answers.find(candidate => candidate.ref === ref);
    if (better?.grounded || better?.applicationQuestion === false) answer = better;
  }
  if (!answer || answer.applicationQuestion === false) return ok('That dropdown was not identified as an application question. Re-observe before choosing an option.');
  if (!answer.grounded) {
    if (!field.required) {
      ctx.guards.pendingFields.delete(field.label);
      ctx.guards.skippedOptional.add(field.label);
      return ok(`Left optional dropdown "${field.label}" unchanged because the profile does not support an answer.`);
    }
    ctx.guards.rememberField(field, answer.candidatePrompt?.trim() || `What should Owtomate select for “${field.label}”?`);
    ctx.guards.recordUngrounded(field.label);
    return ok(`No verified candidate fact supports an option for "${field.label}". Do not choose one; finish needs_human after completing other useful fields.`);
  }
  const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The answer model chose from these exact options; a substring fallback once let "Male" select "Female".
  const choice = group.find(action => normal(action.value!) === normal(answer!.value));
  if (!choice) return ok(`The grounded answer "${answer.value}" is not among the currently observed options. Search or reopen the dropdown; do not choose a substitute.`);
  if (!await clickRef(ctx.page, choice.ref)) return ok('The grounded option could not be clicked. Re-observe the current dropdown.');
  ctx.guards.recordFillSuccess(field.label);
  const prior = ctx.captured.findIndex(item => item.question === field.label);
  if (prior >= 0) ctx.captured.splice(prior, 1);
  ctx.captured.push({ question: field.label, answer: choice.value! });
  ctx.guards.recordProgress();
  return ok(`Selected the grounded option for "${field.label}": ${choice.value}. Inspect the page to verify it was retained.`);
}

async function doAcceptTerms(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const field = ctx.observation.fields.find(candidate => candidate.ref === ref);
  const action = ctx.observation.actions.find(candidate => candidate.ref === ref);
  let label = field?.label ?? action?.text ?? '';
  let coordinateInput = null as ReturnType<Page['locator']> | null;
  let coordinateKind: 'native' | 'aria' | null = null;
  if (!field && !action && ctx.observation.screenshot) {
    const gx = Number(args.x);
    const gy = Number(args.y);
    if (gx >= 0 && gx <= 1000 && gy >= 0 && gy <= 1000) {
      const size = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 800 }));
      const target = await ctx.page.evaluate(({ x, y }) => {
        document.querySelector('[data-agent-consent-target]')?.removeAttribute('data-agent-consent-target');
        const element = document.elementFromPoint(x, y);
        const wrapped = element?.closest('label') as HTMLLabelElement | null;
        let input: Element | null = element instanceof HTMLInputElement && element.type === 'checkbox'
          ? element
          : wrapped?.control instanceof HTMLInputElement && wrapped.control.type === 'checkbox'
            ? wrapped.control
            : element?.closest('[role="checkbox"]')
              ?? element?.querySelector('input[type="checkbox"], [role="checkbox"]') as Element | null;
        let context: Element | null = wrapped ?? element;
        // Some design systems render the input and its prose as siblings.
        // Walk only to the nearest block containing exactly one checkbox, so
        // coordinates can never ambiguously select from a group of answers.
        for (let depth = 0; !input && context && depth < 5; depth++, context = context.parentElement) {
          const boxes = context.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
          if (boxes.length === 1) input = boxes[0] as HTMLInputElement;
        }
        if (!input) return null;
        input.setAttribute('data-agent-consent-target', 'true');
        let wording = wrapped?.innerText || input.getAttribute('aria-label') || '';
        for (let prose = input.parentElement, depth = 0; !wording && prose && depth < 6; prose = prose.parentElement, depth++) {
          const text = (prose.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (/\b(terms?|privacy|consent|acknowledg(?:e|ement)|data processing)\b/i.test(text)) wording = text;
        }
        return {
          label: (wording || context?.textContent || input.closest('[role="group"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          kind: input instanceof HTMLInputElement ? 'native' : 'aria',
        };
      }, { x: (gx / 1000) * size.width, y: (gy / 1000) * size.height }).catch(() => null);
      if (target) {
        label = target.label;
        coordinateKind = target.kind as 'native' | 'aria';
        coordinateInput = ctx.page.locator('[data-agent-consent-target="true"]').first();
      }
    }
  }
  if (!field && !action && !coordinateInput) return ok('Use a current FIELD/ACTION ref, or screenshot x/y, for the consent checkbox. Re-observe rather than guessing.');
  // Always the model: "Send me job alerts per our Privacy Policy" names privacy
  // and is marketing, which a keyword shortcut used to tick. A failed check refuses.
  if (!(await isRequiredConsent(label).catch(() => false))) {
    await coordinateInput?.evaluate(element => element.removeAttribute('data-agent-consent-target')).catch(() => {});
    return ok('Refused: that control is not visibly labelled as required terms, privacy, consent or acknowledgement. Use the grounded answer tool for application questions.');
  }
  if (coordinateInput) {
    try {
      if (coordinateKind === 'native') {
        if (!await setChecked(coordinateInput, true)) return ok('The consent checkbox did not stay checked. Re-observe the current control.');
      } else {
        await coordinateInput.click({ timeout: 5_000 });
        if (await coordinateInput.getAttribute('aria-checked') !== 'true') return ok('The consent checkbox did not stay checked. Re-observe the current control.');
      }
    } finally {
      await coordinateInput.evaluate(element => element.removeAttribute('data-agent-consent-target')).catch(() => {});
    }
  } else if (field) {
    if (field.kind !== 'checkbox') return ok('The consent FIELD is not a checkbox. Re-observe and use its visible ACTION instead.');
    const input = ctx.page.locator(`[data-field-id="${field.ref}"]`).first();
    if (!await setChecked(input, true)) return ok('The consent checkbox did not stay checked. Re-observe the current control.');
    ctx.guards.pendingFields.delete(field.label);
    ctx.guards.resolveGrounding(field.label);
  } else {
    if (action!.role !== 'toggle') return ok('The consent ACTION is not a checkbox or switch. Re-observe the current control.');
    if (!await clickRef(ctx.page, action!.ref)) return ok('The consent control could not be clicked. Re-observe the current page.');
  }
  ctx.guards.recordProgress();
  return ok(`Accepted the required site consent: "${label}". Inspect the page before continuing.`);
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
      noteAction(ctx, { kind: 'authentication-prepared', purpose: 'create_account', site, email, detail: `Filled account-registration fields on ${siteName(site)} with ${email}; account creation is not yet confirmed.` });
    } else if (purpose === 'reset_password') {
      noteAction(ctx, { kind: 'authentication-prepared', purpose: 'reset_password', site, email, detail: `Filled password-reset fields on ${siteName(site)}; reset is not yet confirmed.` });
    } else {
      noteAction(ctx, { kind: 'authentication-prepared', purpose: 'sign_in', site, email, detail: `Filled sign-in fields on ${siteName(site)} with ${email}; sign-in is not yet confirmed.` });
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
    const second = await answerFields(unsure, ctx.job, ctx.profile).catch(() => null);
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
  const searched: string[] = [];
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
      const input = ctx.page.locator(`[data-field-id="${field.ref}"]`).first();
      const selected = field.autocomplete && !field.validationError && field.currentValue?.trim() === value.trim()
        && await input.getAttribute('aria-expanded').catch(() => null) === 'false';
      const interaction = args.interaction === 'type' ? 'type' : args.interaction === 'search' || field.autocomplete ? 'search' : 'type';
      if (!selected) await fillField(ctx.page, field, value, interaction);
      if (interaction === 'search' && field.autocomplete && !selected) {
        searched.push(field.label);
        continue;
      }
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
    (failed.length
      ? `Not accepted; re-observe and recover:\n${failed.join("\n")}\n` +
        'If a failed field is a custom dropdown, operate it the way a person does: click its control (or press_key ArrowDown ' +
        'with its ref) so its entries appear as [option] actions, then call choose_option with the matching option ref and ' +
        'this field as field_ref. A widget that rejects automatic filling is not a missing answer.\n'
      : '') +
    `Verified ${filled.length} field(s):\n${filled.map((line) => `  - ${line}`).join('\n')}` +
      (searched.length ? `\nSearch text entered, not yet selected: ${searched.join('; ')}. Its suggestions now show as [option] actions: call choose_option with the matching option ref and this field as field_ref. If no options appear, open the list with click or press_key ArrowDown first.` : '') +
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
  const upload = ctx.observation.actions.find(action => action.ref === args.ref && action.role === 'file');
  if (upload) return addCoverLetterFile(ctx, upload);
  const field = ctx.observation.fields.find(field => field.ref === args.ref);
  if (field && ['radio', 'select'].includes(field.kind) && typeof args.option === 'string' && field.options?.includes(args.option)) {
    try { await fillField(ctx.page, field, args.option); }
    catch {
      return ok('The cover-letter control changed after the last observation. Re-observe and use the current FIELD ref; do not abandon the application.');
    }
    return ok('Cover-letter option selected. Re-observe, then call add_cover_letter with the writing FIELD ref.');
  }
  /**
   * A writing box inside an embedded form is only in the snapshot (JobAdder's
   * "Tell us more" on dws.hcltech.com), never in the observation. Without
   * this the agent could not write the letter there — nor replace the text
   * another employer's letter had left in it, which the submit audit then
   * rightly refused to send.
   */
  const embedded = !field ? locate(ctx.page, String(args.ref ?? '')) : null;
  const embeddedKind = embedded
    ? await embedded.evaluate((el) => el instanceof HTMLTextAreaElement ? 'textarea'
      : el instanceof HTMLInputElement && ['text', ''].includes(el.type) ? 'text' : 'other').catch(() => 'other')
    : 'other';
  const writable = embedded && embeddedKind !== 'other' ? embedded : null;
  if (!writable && (!field || !['textarea', 'text'].includes(field.kind) || field.sensitive)) {
    return ok('Choose the visible cover-letter FIELD ref. If it is hidden, use click to open the write-letter option, then observe again. Never choose an unrelated text box.');
  }
  const target = writable ?? ctx.page.locator(`[data-field-id="${field!.ref}"]`);
  const label = field?.label ?? 'cover letter';
  let letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');
  const maxLength = await target.evaluate(el => (el as HTMLTextAreaElement).maxLength).catch(() => -1);
  if (Number.isInteger(maxLength) && maxLength >= 0) letter = await fitCoverLetterToLimit(letter, maxLength, ctx.job, ctx.profile);
  try {
    if (field) await fillField(ctx.page, field, letter, 'type');
    else {
      // fill() replaces whatever the box held; read back so a box that rejected it is not reported as written.
      await writable!.fill(letter, { timeout: 10_000 });
      const held = await writable!.inputValue({ timeout: 5_000 });
      if (held.replace(/\s+/g, ' ').trim() !== letter.replace(/\s+/g, ' ').trim()) throw new Error('the box did not keep the letter');
    }
  }
  catch (error) { return ok(`Cover letter not accepted: ${(error as Error).message}. Re-observe and choose the current writing field or resolve the form's validation.`); }
  ctx.coverLetter = letter;
  ctx.guards.recordFillSuccess(label);
  if (config.humanizer.enabled) countHealth(wasHumanized(letter) ? 'humanizedLetters' : 'draftLetters');
  ctx.log(`  ✓ ${wasHumanized(letter) ? 'humanized' : config.humanizer.enabled ? 'unhumanized (grounded draft)' : 'personalized'} cover letter added`);
  return ok(`Cover letter verified in ${field?.ref ?? String(args.ref)}. Re-observe the page and handle any remaining fields or validation before continuing.`);
}

/**
 * The same grounded, humanized letter, sent as a document to a form that
 * only takes the cover letter as an upload (Oracle Recruiting Cloud, many
 * PageUp forms). Written as text, then converted to what the input accepts,
 * PDF when it does not say.
 */
async function addCoverLetterFile(ctx: ToolContext, action: Observation['actions'][number]): Promise<ToolResult> {
  if (/image/i.test(action.text) && !/letter|document|cv|resume/i.test(action.text)) {
    return ok('That upload is for an image, not a cover letter. Choose the cover-letter upload from a fresh observation.');
  }
  const input = ctx.page.locator(`input[type="file"][data-ref-id="${action.ref}"]`);
  const accept = (await input.getAttribute('accept').catch(() => null)) ?? '';
  const document = await coverLetterDocument(ctx, accept);
  if (!document) return ok(`This upload only accepts "${accept}", and the cover letter could not be produced in that format. Look for a text box or another option.`);
  try { await input.setInputFiles(document.file, { timeout: 10_000 }); }
  catch { return ok('The cover-letter upload control changed after the last observation. Re-observe and use the current upload ACTION ref.'); }
  coverLetterSent(ctx, document);
  return ok('Cover letter uploaded as a document. Re-observe: confirm the file appears and resolve any upload error before continuing.');
}

/** The grounded letter as a file this upload accepts: PDF when it may, otherwise what it lists. */
export async function coverLetterDocument(ctx: ToolContext, accept: string): Promise<{ file: string; letter: string } | null> {
  const letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');
  const dir = resolve(config.dataDir, 'cover-letters');
  mkdirSync(dir, { recursive: true });
  const name = `Cover Letter - ${ctx.profile.name} - ${ctx.job.company}`.replace(/[^\w .-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const text = resolve(dir, `${name}.txt`);
  writeFileSync(text, letter);
  // A document reads better than plain text; plain text is the fallback a form that lists .txt still takes.
  const file = (acceptsFormat(accept, '.pdf') ? await documentFor(text, '.pdf') : null) ?? (await documentFor(text, accept));
  return file ? { file, letter } : null;
}

export function coverLetterSent(ctx: ToolContext, document: { file: string; letter: string }): void {
  ctx.coverLetter = document.letter;
  ctx.guards.recordProgress();
  if (config.humanizer.enabled) countHealth(wasHumanized(document.letter) ? 'humanizedLetters' : 'draftLetters');
  ctx.log(`  ✓ ${wasHumanized(document.letter) ? 'humanized' : config.humanizer.enabled ? 'unhumanized (grounded draft)' : 'personalized'} cover letter uploaded as ${extname(document.file).slice(1).toUpperCase()}`);
}

/** The approved résumé as a file this upload accepts, or why not. */
export async function resumeDocument(ctx: ToolContext, accept: string, format = ''): Promise<{ file: string; label: string } | { error: string }> {
  const wanted = await pickResumeForJob(ctx.job, ctx.profile);
  if (!wanted) return { error: 'No approved local resume is available.' };
  if (!config.resume.allowUpload) return { error: 'Resume uploading is disabled.' };
  const file = resolve(RESUME_DIR, wanted.fileName);
  const within = relative(RESUME_DIR, file);
  if (!within || within.startsWith('..') || isAbsolute(within) || !existsSync(file)) return { error: 'The approved resume file is unavailable.' };
  const upload = await documentFor(file, format || accept);
  if (!upload) return { error: `This upload only accepts "${accept}", and the resume could not be produced in that format.` };
  return { file: upload, label: wanted.label };
}

export function resumeSent(ctx: ToolContext, label: string): void {
  ctx.resumeUsed = label;
  const site = hostOf(ctx.page.url());
  noteAction(ctx, { kind: 'resume-uploaded', site, detail: `Sent "${label}" to the resume upload control on ${siteName(site)}.` });
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
    try { await fillField(ctx.page, field, option); }
    catch {
      return ok(`${identity} The resume control changed after the last observation. Re-observe and use the current FIELD or upload ACTION ref; do not abandon the application.`);
    }
    ctx.resumeUsed = wanted.label;
    ctx.guards.recordFillSuccess(field.label);
    return ok('Resume selection verified. Re-observe before continuing.');
  }
  if (!action || action.disabled || !/^a\d+$/.test(ref)) {
    return ok(`${identity} Pass the observed resume upload ACTION ref, or a radio/select FIELD ref plus its exact option. If the control is hidden, open it with click and observe again. Do not use a photo upload.`);
  }
  const input = ctx.page.locator(`input[type="file"][data-ref-id="${ref}"]`);
  const accept = await input.getAttribute('accept') ?? '';
  if (/image\//i.test(accept) && !/pdf|word|document|\.doc|\.rtf|\.txt/i.test(accept)) {
    return ok('That upload accepts images, not a resume. Choose the document upload from a fresh observation.');
  }
  const format = typeof args.format === 'string' && /^(pdf|docx|doc|rtf|txt)$/.test(args.format) ? `.${args.format}` : '';
  const document = await resumeDocument(ctx, accept, format);
  if ('error' in document) return ok(`${identity} ${document.error} Select a matching existing document or another upload option on the page; otherwise finish with cannot_complete.`);
  try { await input.setInputFiles(document.file, { timeout: 10_000 }); }
  catch {
    return ok(`${identity} The resume upload control changed after the last observation. Re-observe and use the current upload ACTION ref; do not abandon the application.`);
  }
  const retained = await input.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name ?? '').catch(() => '');
  if (retained) resumeSent(ctx, wanted.label);
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
  /**
   * CAPTCHAs belong to CapMonster, never to the model's judgment. A widget
   * that loads only when scrolled into view is invisible to the check that
   * runs before every tool, so the agent once gave up on a plain "I'm not a
   * robot" box nobody had tried. Bring every lazy widget into view and let
   * the solver have its turn before any give-up over one is accepted.
   */
  if (/captcha|robot|security verification|verify (?:that )?you(?:'| a)re human|bot check/i.test(reason) && ['cannot_complete', 'needs_human'].includes(String(args.status))) {
    await ctx.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await ctx.page.waitForTimeout(2_500).catch(() => {});
    const captcha = await handleCaptchaWithCapMonster(ctx.page);
    if (captcha === 'solved') return ok('CapMonster cleared the verification. Re-observe the page and continue the application.');
    if (captcha === 'none') ctx.log('  · the agent reported a CAPTCHA, but none is on the page');
  }
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
    case 'already_applied': {
      /**
       * "You have already applied" right after this attempt pressed submit is
       * usually this attempt's own success, shown on a status page instead of
       * a thank-you page. Recording it as a prior application loses a real
       * submission from the candidate's list, so the same independent check
       * that backs confirm_submission decides.
       */
      if (ctx.submissionAttempted) {
        const evidence = await submissionEvidence(ctx);
        if (await verifySubmissionEvidence(evidence, ctx.job).catch(() => false)) {
          return { kind: 'terminal', outcome: { status: 'applied' } };
        }
      }
      return { kind: 'terminal', outcome: { status: 'already-applied', reason } };
    }
    case 'nothing_to_apply_to':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    case 'cannot_complete':
      return { kind: 'terminal', outcome: { status: 'skipped', reason } };
    default:
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
          actionRef: (element.closest('[data-ref-id]') ?? clickable.closest('[data-ref-id]'))?.getAttribute('data-ref-id') ?? null,
          fieldRef: field?.getAttribute('data-field-id') ?? null,
          formControl: clickable.matches('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="switch"]')
            || Boolean(clickable.matches('label') && (clickable as HTMLLabelElement).control)
            || Boolean(clickable.querySelector('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="switch"]')),
          text: ((clickable as HTMLElement).innerText || (clickable instanceof HTMLInputElement ? clickable.value : '') || clickable.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          href: link ? (link as HTMLAnchorElement).href : null,
        };
      },
      { x, y },
    )
    .catch(() => null);
  if (!under) return ok('Nothing is under that point. Re-observe and try a ref or a different point.');
  const pointedAction = under.actionRef ? ctx.observation.actions.find(action => action.ref === under.actionRef) : undefined;
  if (pointedAction?.role === 'option') return ok('That point targets a dropdown option. Use choose_option so the choice is grounded in the candidate profile; coordinate bypasses are refused.');
  if (under.fieldRef || under.formControl) return ok(`That point targets ${under.fieldRef ? `FIELD ${under.fieldRef}` : 'a form control'}. Use its grounded field tool; for a required terms checkbox use accept_terms (with its ref, or the same screenshot x/y). Coordinates cannot bypass answer verification.`);
  if (under.href && isAustralianGovernmentUrl(under.href)) {
    return {
      kind: 'terminal',
      outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
    };
  }
  if (under.href && isForbiddenDestination(under.href)) {
    return ok(`Refused: that point is a link to ${under.href}, which this tool never navigates to.`);
  }
  const gate = await gateAdvance(ctx, under.text);
  if (!gate.proceed) return gate.result;
  const before = await captureInteractivePageState(ctx.page);
  await ctx.page.mouse.click(x, y);
  const changed = await waitForInteractivePageChange(ctx.page, before);
  await waitForInteractiveSurface(ctx.page, 4_000);
  return ok(
    `Clicked at (${gx},${gy}) on <${under.tag.toLowerCase()}> "${under.text}". ` +
      (changed ? 'The page changed; a fresh observation follows.' : 'Nothing on the page changed.'),
  );
}

export async function fillEmailedCode(page: Page, fields: Observation['fields'], code: string): Promise<boolean> {
  if (!fields.length || new Set(fields.map(f => f.ref)).size !== fields.length) return false;
  if (fields.length > 1 && fields.length !== code.length) return false;
  const inputs = fields.map(field => page.locator(`[data-field-id="${field.ref}"]`));
  const values = fields.length === 1 ? [code] : [...code];
  // Validate the model's complete selection before typing any private code.
  for (let i = 0; i < inputs.length; i++) {
    const capacity = await inputs[i].evaluate(el => (el as HTMLInputElement).maxLength);
    if (capacity >= 0 && capacity < values[i].length) return false;
  }
  for (let i = 0; i < inputs.length; i++) {
    await inputs[i].fill(values[i], { timeout: 5_000 });
    // The final digit can auto-advance the page; fresh observation verifies that.
    if (i < inputs.length - 1 && await inputs[i].inputValue() !== values[i]) return false;
  }
  return true;
}

async function doEnterEmailedCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!browserGmailAvailable()) {
    return ok('No mailbox is signed in for this candidate. Try another authentication option; otherwise finish with "cannot_complete".');
  }
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [String(args.ref ?? '')];
  const fields = refs.map(ref => ctx.observation.fields.find(candidate => candidate.ref === ref));
  if (!fields.length || fields.some(field => !field) || new Set(refs).size !== refs.length) return ok('Choose current code FIELD refs: ref for one input, or refs for all separate digit boxes in order.');
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification code');

  const found = await findVerificationInBrowser(ctx.page.context(), { hint, site: hostOf(ctx.page.url()), want: 'code', timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  if (!('error' in found) && found.kind !== 'code') return ok('The email carries a link, not a code. Call open_emailed_link instead.');
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    /**
     * A signed-out mailbox is not a slow email, and calling this again will
     * not fix it. Saying so ends the attempt in one step instead of spending
     * another ninety seconds finding out the same thing.
     */
    if (/signed out/i.test(found.error)) return ok(`${found.error} Try another authentication option; otherwise finish with "cannot_complete".`);
    return ok(`${found.error} If the page has a resend control, click it and call this again once; otherwise finish with "cannot_complete".`);
  }

  try {
    if (!await fillEmailedCode(ctx.page, fields as Observation['fields'], found.value)) return ok('Code entry needs a different field selection. For separate digit boxes, select ALL current code FIELD refs in order using refs. Re-observe before retrying.');
  } catch {
    return ok('The code inputs changed or could not be filled. Inspect the fresh page: it may have advanced automatically; otherwise select the current code fields and retry.');
  }
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
  return ok('Entered the emailed code into the selected fields. Inspect the page to verify acceptance before continuing.');
}

/** How long the inbox is watched for a site's email before the agent is told to resend. */
const EMAIL_WAIT_MS = 120_000;

async function doOpenEmailedLink(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!browserGmailAvailable()) {
    return ok('No mailbox is signed in for this candidate. Try another authentication option; otherwise finish with "cannot_complete".');
  }
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification link');
  const found = await findVerificationInBrowser(ctx.page.context(), { hint, site: hostOf(ctx.page.url()), want: 'link', timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    if (/signed out/i.test(found.error)) return ok(`${found.error} Try another authentication option; otherwise finish with "cannot_complete".`);
    return ok(`${found.error} If the page has a resend control, click it and call this again once; otherwise finish with "cannot_complete".`);
  }
  if (isAustralianGovernmentUrl(found.value)) {
    return { kind: 'terminal', outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' } };
  }
  if (isForbiddenDestination(found.value)) return ok('The emailed link points somewhere this agent never navigates. Try another authentication option.');
  // A new tab keeps the form behind it intact; the loop follows the new tab.
  const tab = await ctx.page.context().newPage();
  await tab.goto(found.value, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  ctx.guards.recordProgress();
  const site = hostOf(found.value);
  noteAction(ctx, { kind: 'email-code', site, detail: `Opened the verification link ${siteName(site)} emailed you ("${found.subject.slice(0, 60)}").` });
  ctx.log(`  ✉ opened the emailed link from "${found.subject.slice(0, 60)}"`);
  return ok('Opened the emailed link in a new tab; the application continues there. Inspect it: sign in or continue the application if the account is now verified.');
}

async function doPressKey(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const key = String(args.key ?? '').trim();
  if (!/^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)+)*(?:[A-Z][A-Za-z0-9]+|[a-z0-9]|Space| )$/.test(key)) {
    return ok('Unsupported key. Use a key name such as ArrowDown, Enter, Escape, Tab or Backspace, a single character, or a combination such as Control+A.');
  }
  if (typeof args.ref === 'string' && args.ref) {
    const target = locate(ctx.page, args.ref);
    const focused = target && await target.focus({ timeout: 3_000 }).then(() => true).catch(() => false);
    if (!focused) return ok(`${args.ref} could not be focused. Re-observe and use a current ref.`);
  }
  return pressWatched(ctx, key, async () => {
    const before = await captureInteractivePageState(ctx.page);
    await ctx.page.keyboard.press(key);
    const changed = await waitForInteractivePageChange(ctx.page, before, 2_500);
    return ok(`Pressed ${key}. ${changed ? 'The page changed; a fresh observation follows.' : 'Nothing visible changed.'}`);
  });
}

/**
 * The most any one tool may take. A tool that never returns (a page that
 * stops answering an evaluate, a navigation that never commits) must not
 * freeze the run: the agent is told and re-observes instead. Generous enough
 * for the slow legitimate cases — a humanized letter, an email arriving.
 */
const TOOL_TIME_LIMIT_MS: Record<string, number> = {
  add_cover_letter: 300_000,
  enter_emailed_code: EMAIL_WAIT_MS + 60_000,
  open_emailed_link: EMAIL_WAIT_MS + 60_000,
  answer_questions: 180_000,
  attach_resume: 180_000,
  upload_file: 300_000,
  fill_element: 180_000,
  evaluate_script: 90_000,
};
const DEFAULT_TOOL_TIME_LIMIT_MS = 120_000;

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  /**
   * Challenge controls never reach an AI-selected action. This also closes
   * the race where a CAPTCHA appears after observation but before the click.
   * Solved before the tool's clock starts: CapMonster has its own deadline
   * (200s a task, one retry), longer than any tool's, and inside the clock a
   * slow solve abandoned the tool mid-solve (Macquarie's registration page).
   */
  if (!('__parseError' in args)) {
    const captcha = await handleCaptchaWithCapMonster(ctx.page);
    if (captcha === 'solved') {
      // A clearing that took minutes is progress, not a stuck page.
      ctx.guards.recordProgress();
      return ok('CapMonster cleared the security verification. Re-observe the page and continue.');
    }
    if (captcha === 'blocked') {
      return {
        kind: 'terminal',
        outcome: { status: 'needs-human', reason: 'CapMonster could not clear the site security verification.' },
      };
    }
  }
  const limit = TOOL_TIME_LIMIT_MS[name] ?? DEFAULT_TOOL_TIME_LIMIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ToolResult>((done) => {
    timer = setTimeout(() => {
      ctx.log(`  ⏱ ${name} did not finish within ${Math.round(limit / 1000)}s; continuing without it`);
      done(ok(`The ${name} call did not finish within ${Math.round(limit / 1000)} seconds and was abandoned. The page may have changed: re-observe before acting.`));
    }, limit);
  });
  try {
    return await Promise.race([runTool(ctx, name, args), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if ('__parseError' in args) {
    return ok('Your tool arguments were not valid JSON. Call the tool again with well-formed arguments.');
  }
  rememberCoverLetterOpportunity(ctx);
  switch (name) {
    case 'choose_option':
      return doChooseOption(ctx, args);
    case 'accept_terms':
      return doAcceptTerms(ctx, args);
    case 'wait_for_page': {
      const before = await captureInteractivePageState(ctx.page);
      const changed = await waitForInteractivePageChange(ctx.page, before, 10_000);
      return ok(changed ? 'The page changed while waiting. Inspect the fresh observation.' : 'No page change after waiting 10 seconds. Inspect the page before choosing a recovery action.');
    }
    case 'confirm_submission': {
      if (!ctx.submissionAttempted) return ok('No submission action has been recorded for this attempt. Do not claim success; inspect the page.');
      const evidence = await submissionEvidence(ctx);
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
    case 'open_emailed_link':
      return doOpenEmailedLink(ctx, args);
    case 'press_key':
      return doPressKey(ctx, args);
    case 'click_point':
      return doClickPoint(ctx, args);
    default:
      return (config.celeris.rawTools ? await runRawTool(ctx, name, args) : null) ?? ok(`No such tool "${name}".`);
  }
}
