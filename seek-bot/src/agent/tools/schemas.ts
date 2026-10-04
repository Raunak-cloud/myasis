import { config } from '../../config.js';
import type { ToolSchema } from '../celeris.js';
import { browserGmailAvailable } from '../../browser-gmail.js';
import { RAW_TOOL_SCHEMAS } from '../raw-tools.js';
import { ANSWER_BATCH } from './context.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

export const EMAILED_CODE_TOOL: ToolSchema = {
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

export const EMAILED_LINK_TOOL: ToolSchema = {
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

export const CLICK_POINT_TOOL: ToolSchema = {
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
  ].map(withPressJudgement);
}

/**
 * What the agent itself judges about a press, carried on the press: whether
 * it sends the finished application, and, when moving on without a cover
 * letter, why the form has no place for one. The agent sees the whole page
 * and already says so in its reason ("Submit the application by clicking
 * Apply"); a separate model asked the first question again on every forward
 * press, and a word-matching rule answered the second.
 */
const PRESSING_TOOLS = new Set(['click', 'click_element', 'click_point', 'press_key']);
function withPressJudgement(tool: ToolSchema): ToolSchema {
  if (!PRESSING_TOOLS.has(tool.name)) return tool;
  const parameters = tool.parameters as { properties?: Record<string, unknown> };
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(parameters.properties ?? {}),
        sends_application: {
          type: 'boolean',
          description: 'Your judgement: true when this press sends the finished application to the employer (the final submit), false for anything else (opening the form, Next, Continue, Save, a menu).',
        },
        no_cover_letter_place: {
          type: 'string',
          description: 'Only when moving on or submitting without having added a cover letter: what you checked that shows this form has no place for one (no cover-letter box, no supporting-documents upload, after scrolling and opening any Add control).',
        },
      },
    },
  };
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
    description: 'Wait for a loading page or pending request to change, without clicking or reloading. Returns as soon as the page changes or has finished loading, at most 10 seconds. Use before recovery actions when the page is still loading. Existing run budgets still apply.',
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
      'Do not use answer_questions for credentials. After filling, click the sign-in, create-account or continue control. ' +
      "When creating an account or setting a new password, read the site's password requirements (stated beside the field, " +
      'or in the message after a rejected password) and pass them as password_rules; the password is then built to fit them. ' +
      'You never see or choose the password itself.',
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
        password_rules: {
          type: 'object',
          description: "For create_account and reset_password: the site's password requirements as the page states them. Omit what it does not say.",
          properties: {
            max_length: { type: 'integer', description: 'Most characters allowed.' },
            min_length: { type: 'integer', description: 'Fewest characters required.' },
            symbols: { type: 'string', enum: ['required', 'allowed', 'not_allowed'], description: 'Whether special characters are required, allowed or forbidden.' },
            allowed_symbols: { type: 'string', description: 'The special characters the site accepts, when it lists them, e.g. "!@#$".' },
          },
        },
      },
      required: ['refs', 'purpose', 'reason'],
    },
  },
  {
    name: 'answer_questions',
    description:
      `Answer the unanswered applicant FIELDs on this page in one turn: pass their refs in page order (up to ${ANSWER_BATCH}). ` +
      'They are answered together and filled in that order; the tool stops by itself when a fill rebuilds the form ' +
      '(a checkbox reveals new fields, a choice changes the next options) and names the fields left, so re-observe and continue. ' +
      'You do NOT write the answers — they are generated from the verified candidate profile and filled in for you. ' +
      'Do not include the cover-letter textarea or file inputs here.',
    parameters: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: ANSWER_BATCH,
          description: 'Field refs from the current FIELDS list, in page order, e.g. ["f0", "f1", "f2"].',
        },
        reason: { type: 'string', description: 'What this step is asking for.' },
        required_refs: { type: 'array', items: { type: 'string' }, description: 'Subset of refs required by current page instructions or validation despite missing markup. Explain the evidence in reason. Never mark every option of a multi-select group required.' },
        questions: {
          type: 'array',
          items: { type: 'object', properties: { ref: { type: 'string' }, question: { type: 'string' } }, required: ['ref', 'question'] },
          description: 'For a FIELD whose listed label is not its question (a custom dropdown listed as "Yes No Select an option"), the question the page shows beside that control, copied from the page. The answer is still worked out from the candidate profile; never invent a question.',
        },
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
