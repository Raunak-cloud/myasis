import type { Page } from 'patchright';
import { fillField } from '../../dom.js';
import type { Observation } from '../observe.js';
import { isForbiddenDestination } from '../guards.js';
import { browserGmailAvailable, findVerificationInBrowser } from '../../browser-gmail.js';
import { authenticationValue, hostOf, normalizeRules, type SiteCredential } from '../../site-auth.js';
import { storedCredential } from '../../site-credentials.js';
import { isAustralianGovernmentUrl } from '../../site-policy.js';
import { ToolResult, ToolContext, ok, noteAction, siteName } from './context.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

export async function doCompleteAuthentication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
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
        ? ` Use answer_questions for the remaining profile field(s): ${unsupported.map((entry) => `${entry.field.ref} (${entry.field.label})`).join(', ')}.`
        : '') +
      (failed.length ? ` Re-observe and retry fields the site rejected: ${failed.join('; ')}` : '') +
      ' Continue with the sign-in or account-creation control.' +
      (setsPassword ? ' If the site then rejects the password for its rules, call complete_authentication again with password_rules taken from that message.' : ''),
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

export async function doEnterEmailedCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!browserGmailAvailable()) {
    return ok('No mailbox is signed in for this candidate. Try another authentication option; otherwise finish with "cannot_complete".');
  }
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [String(args.ref ?? '')];
  const fields = refs.map(ref => ctx.observation.fields.find(candidate => candidate.ref === ref));
  if (!fields.length || fields.some(field => !field) || new Set(refs).size !== refs.length) return ok('Choose current code FIELD refs: ref for one input, or refs for all separate digit boxes in order.');
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification code');

  const found = await findVerificationInBrowser(ctx.page.context(), { hint, site: hostOf(ctx.page.url()), want: 'code', timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  if (!('error' in found) && found.kind !== 'code') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a link, not a code. Call open_emailed_link instead.`);
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
export const EMAIL_WAIT_MS = 120_000;

export async function doOpenEmailedLink(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
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
  if (found.kind !== 'link') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a code, not a link. Call enter_emailed_code with the code field(s) instead.`);
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
