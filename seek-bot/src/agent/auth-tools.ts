import { gmailAvailable } from '../gmail-mailbox.js';
import type { ToolSchema } from './celeris.js';

export const AUTHENTICATION_TOOL: ToolSchema = {
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
  };

export const EMAILED_CODE_TOOL: ToolSchema = {
  name: 'enter_emailed_code',
  description:
    'When the page asks for a code that was emailed to the candidate (verification code, one-time passcode, sign-in code), ' +
    "call this with the ref of the code FIELD after the email has been requested. The code is read from the candidate's " +
    'inbox through Gmail MCP and typed into that field for you. For separate digit boxes, supply refs in visual reading order instead of ref. Never type a code yourself.',
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
    "from the candidate's inbox through Gmail MCP and opened in a new tab, where the application continues. Never guess or type a link.",
  parameters: {
    type: 'object',
    properties: { sender_hint: { type: 'string', description: 'The site or company that sent the email, e.g. "Workday" or the employer.' } },
    required: [],
  },
};

/** Credential and connected-inbox helpers shared by the sole applying agent. */
export function authenticationTools(): ToolSchema[] {
  return [AUTHENTICATION_TOOL, ...(gmailAvailable() ? [EMAILED_CODE_TOOL, EMAILED_LINK_TOOL] : [])];
}
