import { gmailAvailable } from '../gmail-mailbox.js';
import type { ToolSchema } from './celeris.js';
import { browserTargetProperties } from './browser-target.js';
import { VERIFICATION_PURPOSES } from '../verification-email-local.js';

const targets = { type: 'array', minItems: 1, maxItems: 12, items: {
  type: 'object', additionalProperties: false,
  properties: { ...browserTargetProperties, ref: { type: 'string', minLength: 1 }, selector: { type: 'string', minLength: 1 } },
  anyOf: [{ required: ['ref'] }, { required: ['selector'] }, { required: ['locator'] }],
}, description: 'Actual authentication or code input targets. Use current field refs when available; include frame scope for embedded forms.' };
const cachedVerification = {
  credential_id: { type: 'string', minLength: 1, maxLength: 100, description: 'ID from this tool’s message results. Omit on the first call.' },
  purpose: { type: 'string', enum: [...VERIFICATION_PURPOSES], description: 'The email purpose requested by the site: verification, sign-in or reset_password.' },
  allow_recent_cached: { type: 'boolean', description: 'Use a recent cached code/link when the current employer page indicates it is reusable.' },
  cached_code_evidence: { type: 'string', description: 'Evidence that the current code or link is reusable.' },
};

const AUTHENTICATION_TOOL: ToolSchema = {
    name: 'fill_authentication_fields',
    description: "Fill login, registration or reset fields privately. Include their current field numbers in refs, for example refs: [\"f0\", \"f1\"], or use supported targets if refs are unavailable. Check the saved employer account first; reuse accepted credentials. For a new password pass the site's password_rules. Click Continue/Sign in with browser_action, then record_authentication_result.",
  parameters: {
      type: 'object',
      properties: {
        targets,
        refill: { type: 'boolean', description: 'Set true only to trigger input events for an uncommitted/rejected value. Otherwise preserve matching values.' },
        refs: {
          type: 'array',
          minItems: 1, items: { type: 'string', minLength: 1 },
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
      required: ['purpose', 'reason'],
      anyOf: [{ required: ['targets'] }, { required: ['refs'] }],
    },
  };

const EMAILED_CODE_TOOL: ToolSchema = {
  name: 'enter_emailed_code',
  description: "Use only after the site requests an emailed code. First omit credential_id to inspect messages; choose the matching message, then call again with its credential_id and the actual code field targets. Values stay private.",
  parameters: {
    type: 'object',
    properties: {
      ...cachedVerification,
      targets,
      ref: { type: 'string', minLength: 1, description: 'Required unless refs or targets are supplied. The current FIELD ref of the code input.' },
      refs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Required unless ref or targets are supplied. All current code FIELD refs in digit order when the code has separate boxes.' },
      sender_hint: { type: 'string', description: 'The site or company that sent the code, e.g. "Oracle" or "Workday".' },
    },
    required: ['purpose'],
    anyOf: [{ required: ['targets'] }, { required: ['ref'] }, { required: ['refs'] }],
  },
};

const EMAILED_LINK_TOOL: ToolSchema = {
  name: 'open_emailed_link',
  description: "Use only after the site requests an emailed verification, sign-in or reset link. First omit credential_id to inspect messages; choose the matching message, then call again with its credential_id. Opens the link privately in a new tab.",
  parameters: {
    type: 'object',
    properties: { ...cachedVerification, sender_hint: { type: 'string', description: 'The site or company that sent the email, e.g. "Workday" or the employer.' } },
    required: ['purpose'],
  },
};

/** Credential and connected-inbox helpers shared by the sole applying agent. */
export function authenticationTools(): ToolSchema[] {
  return [{name:'check_employer_account',description:"Check this candidate's saved account for the current employer. Missing metadata does not prove no account exists. Describe the observed evidence for existing/not_found. An existing account without a verified login is skipped. Never returns passwords.",parameters:{type:'object',additionalProperties:false,properties:{outcome:{type:'string',enum:['lookup','existing','not_found']},evidence:{type:'string',maxLength:4000}}}},AUTHENTICATION_TOOL, ...(gmailAvailable() ? [EMAILED_CODE_TOOL, EMAILED_LINK_TOOL] : [])];
}
