import type { Locator, Page } from 'patchright';
import { browserTarget } from './browser-target.js';
import type { Observation } from './observe.js';
import { isForbiddenDestination } from './browser-boundaries.js';
import { gmailAvailable, findVerificationInGmail } from '../gmail-mailbox.js';
import { authenticationValue, hostOf, normalizeRules, type SiteCredential } from '../site-auth.js';
import { storedCredential } from '../site-credentials.js';
import { ToolResult, ToolContext, ok, noteAction, siteName } from './context.js';
import { assertLive } from '../tool-run.js';

// Private credential transport. Magnus chooses controls; native fill emits normal input events.

export async function doCompleteAuthentication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
  const fields = ctx.observation.fields.filter((field) => refs.includes(field.ref));
  const selected = new Map<string, Locator>();
  if (Array.isArray(args.targets)) for (const [index, spec] of (args.targets as Record<string, unknown>[]).entries()) {
    const input = browserTarget(ctx.page, spec);
    const facts = await input.evaluate(node => {
      const element = node as HTMLInputElement;
      return { label: [...(element.labels || [])].map(label => label.textContent).join(' ') || node.getAttribute('aria-label') || element.name || '', inputType: element.type, sensitive: element.type === 'password' };
    });
    const ref = `private-native-${index}`;
    fields.push({ ...facts, ref, kind: 'text', required: true });
    selected.set(ref, input);
  }
  if (!fields.length) {
    return ok('None of those refs are authentication fields on this page. Choose refs from the current FIELDS list.');
  }

  /**
   * Which password: a new account or a reset gets a readable one built to the
   * rules the agent read off the page; signing in uses whatever this account
   * was given when it was made (the original formula if Owtomate has no record).
   */
  const purpose = String(args.purpose ?? '');
  const setsPassword = purpose === 'create_account' || purpose === 'reset_password';
  const site = hostOf(ctx.page.url());
  /**
   * A password set in this attempt and not yet accepted is used for signing
   * in on the same site, so a sign-in right after a reset or a sign-up uses
   * the new password. It becomes the account's remembered password only once
   * the site accepts it (see commitCredentials); until then the remembered
   * one stands.
   */
  const credential: SiteCredential | null = setsPassword
    ? { format: 'readable-v1', rules: normalizeRules(args.password_rules) }
    : ctx.pendingCredentials?.get(site) ?? storedCredential(ctx.page.url(), ctx.profile.email);
  const values = fields.map((field) => ({ field, value: authenticationValue(field, ctx.profile, ctx.page.url(), credential) }));
  const unsupported = values.filter((entry) => entry.value === null);
  const missingCredential = unsupported.some((entry) => entry.field.sensitive);
  if (missingCredential) {
    return ok('The private site credential is unavailable. Finish with "skipped" so this job is skipped.');
  }

  const filled: string[] = [];
  const failed: string[] = [];
  for (const { field, value } of values) {
    if (value === null) continue;
    try {
      await (selected.get(field.ref) ?? browserTarget(ctx.page, { ref: field.ref })).fill(value, { timeout: 8000 });
      filled.push(field.label);
    } catch (error) {
      failed.push(`${field.label}: ${(error as Error).message}`);
    }
  }

  /**
   * The candidate now has, or has used, an account they may never have heard
   * of. The purpose is the agent's own reading of the page; the password is
   * not recorded, because the dashboard can derive it again for its owner.
   */
  const credentialFilled = values.some(
    ({ field, value }) => value !== null && (field.sensitive || field.inputType === 'password') && filled.includes(field.label),
  );
  if (credentialFilled) {
    const email = ctx.profile.email;
    // Held until the site accepts it: a sign-up refused because the account already exists must not replace the password it has.
    if (setsPassword && credential) (ctx.pendingCredentials ??= new Map()).set(site, credential);
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
        ? ` Use native browser actions for the remaining profile field(s): ${unsupported.map((entry) => `${entry.field.ref} (${entry.field.label})`).join(', ')}.`
        : '') +
      (failed.length ? ` Re-observe and retry fields the site rejected: ${failed.join('; ')}` : '') +
      ' Continue with the sign-in or account-creation control.' +
      (setsPassword ? ' If the site then rejects the password for its rules, call complete_authentication again with password_rules taken from that message.' : ''),
    failed.length || unsupported.length ? 'failed' : 'completed',
  );
}

export async function fillEmailedCode(page: Page, fields: Observation['fields'], code: string, targets?: Locator[]): Promise<boolean> {
  if (!fields.length || new Set(fields.map(f => f.ref)).size !== fields.length) return false;
  if (fields.length > 1 && fields.length !== code.length) return false;
  const inputs = targets ?? fields.map(field => browserTarget(page, { ref: field.ref }));
  const values = fields.length === 1 ? [code] : [...code];
  // Validate the model's complete selection before typing any private code.
  for (let i = 0; i < inputs.length; i++) {
    const capacity = await inputs[i].evaluate(el => (el as HTMLInputElement).maxLength);
    if (capacity >= 0 && capacity < values[i].length) return false;
  }
  for (let i = 0; i < inputs.length; i++) {
    assertLive();
    await inputs[i].fill(values[i], { timeout: 5_000 });
    // The final digit can auto-advance the page; fresh observation verifies that.
    if (i < inputs.length - 1 && await inputs[i].inputValue() !== values[i]) return false;
  }
  return true;
}

const cannotReadMailbox = (error: string) => /reconnect|authorization|MCP could not|connect Gmail|Gmail.*(?:unavailable|could not|did not)|mailbox request/i.test(error);

export async function doEnterEmailedCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!gmailAvailable()) {
    return ok('Gmail is not connected for this candidate. Connect Gmail in Settings. Try another authentication option; otherwise finish with "skipped".');
  }
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [String(args.ref ?? '')];
  let fields = refs.map(ref => ctx.observation.fields.find(candidate => candidate.ref === ref));
  const targets = Array.isArray(args.targets) ? (args.targets as Record<string, unknown>[]).map(spec => browserTarget(ctx.page, spec)) : undefined;
  if (targets) fields = targets.map((_, index) => ({ ref: `private-code-${index}`, label: 'Verification code', kind: 'text', required: true }));
  if (!fields.length || fields.some(field => !field) || !targets && new Set(refs).size !== refs.length) return ok('Choose current code inputs using targets, or current FIELD refs in digit order.');
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification code');

  const found = await findVerificationInGmail({ hint, site: hostOf(ctx.page.url()), want: 'code', timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  if (!('error' in found) && found.kind !== 'code') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a link, not a code. Call open_emailed_link instead.`);
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    /**
     * A signed-out mailbox is not a slow email, and calling this again will
     * not fix it. Saying so ends the attempt in one step instead of spending
     * another ninety seconds finding out the same thing.
     */
    if (cannotReadMailbox(found.error)) return ok(`${found.error} This is a mailbox access failure, not a delayed email. Follow the mailbox recovery message before requesting another code.`);
    return ok(`${found.error} If the page has a resend control, click it and call this again once; otherwise finish with "skipped".`);
  }

  if (fields.length > 1 && fields.length !== found.value.length) {
    return ok(`The email yielded a ${found.value.length}-character code, but ${fields.length} individual code inputs were selected. Nothing was entered. Inspect whether the complete input group is selected. If it is, report a mailbox/code format mismatch; do not truncate, guess, or repeat the same request unchanged.`, 'failed');
  }
  try {
    if (!await fillEmailedCode(ctx.page, fields as Observation['fields'], found.value, targets)) return ok('Code entry needs a different input selection. Select all current digit boxes in order; inspect the current page before retrying.');
  } catch {
    return ok('The code inputs changed or could not be filled. Inspect the fresh page: it may have advanced automatically; otherwise select the current code fields and retry.');
  }
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
export const EMAIL_WAIT_MS = 120_000;

export async function doOpenEmailedLink(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!gmailAvailable()) {
    return ok('Gmail is not connected for this candidate. Connect Gmail in Settings. Try another authentication option; otherwise finish with "skipped".');
  }
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification link');
  const found = await findVerificationInGmail({ hint, site: hostOf(ctx.page.url()), want: 'link', timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    if (cannotReadMailbox(found.error)) return ok(`${found.error} This is a mailbox access failure, not a delayed email. Follow the mailbox recovery message before requesting another link.`);
    return ok(`${found.error} If the page has a resend control, click it and call this again once; otherwise finish with "skipped".`);
  }
  if (found.kind !== 'link') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a code, not a link. Call enter_emailed_code with the code field(s) instead.`);
  if (isForbiddenDestination(found.value)) return ok('The emailed link points somewhere this agent never navigates. Try another authentication option.');
  // A new tab keeps the form behind it intact; the loop follows the new tab.
  const tab = await ctx.page.context().newPage();
  await tab.goto(found.value, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  ctx.page = tab;
  const site = hostOf(found.value);
  noteAction(ctx, { kind: 'email-code', site, detail: `Opened the verification link ${siteName(site)} emailed you ("${found.subject.slice(0, 60)}").` });
  ctx.log(`  ✉ opened the emailed link from "${found.subject.slice(0, 60)}"`);
  return ok('Opened the emailed link in a new tab; the application continues there. Inspect it: sign in or continue the application if the account is now verified.');
}
