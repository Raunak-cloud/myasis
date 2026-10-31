import type { ElementHandle, Locator, Page } from 'patchright';
import { browserTarget } from './browser-target.js';
import type { Observation } from './observe.js';
import { isForbiddenDestination } from './browser-boundaries.js';
import { gmailAvailable, gmailAccount, findVerificationInGmail } from '../gmail-mailbox.js';
import { authenticationValue, isAuthenticationPasswordField, hostOf, normalizeRules, type SiteCredential } from '../site-auth.js';
import { storedCredential, rejectCredential, commitAcceptedCredentials } from '../site-credentials.js';
import { ToolResult, ToolContext, ok, noteAction, siteName } from './context.js';
import { assertLive } from '../tool-run.js';
import { employerMessageEvidence } from './employer-message.js';
import { rememberPrivateAuthenticationValue, preparePrivateAuthenticationFields } from '../private-auth-fields.js';
import { VERIFICATION_PURPOSES, type VerificationPurpose } from '../verification-email-local.js';

// Private credential transport. Magnus chooses controls; native fill emits normal input events.
const authenticationStarted = new WeakMap<ToolContext, Map<string, number>>();

function rememberAuthenticationStart(ctx: ToolContext, site: string) {
  let starts = authenticationStarted.get(ctx);
  if (!starts) authenticationStarted.set(ctx, starts = new Map());
  if (!starts.has(site)) starts.set(site, Date.now());
  return starts.get(site);
}

function mailboxProblem(ctx: ToolContext): string | null {
  if (!gmailAvailable()) return 'Gmail is not connected for this candidate. Connect Gmail in Settings. Try another authentication option; otherwise finish with "skipped".';
  if (!ctx.profile?.email || ctx.profile.email.trim().toLowerCase() !== gmailAccount().trim().toLowerCase()) {
    return 'The connected Gmail address does not match this candidate profile. Connect the profile Gmail address in Settings before reading verification emails.';
  }
  return null;
}

async function verificationFreshness(ctx: ToolContext, args: Record<string, unknown>): Promise<{ requestedAt?: number; error?: never } | { error: string }> {
  const requestedAt = authenticationStarted.get(ctx)?.get(hostOf(ctx.page.url()));
  if (args.allow_recent_cached !== true) return { requestedAt };
  const quote = typeof args.cached_code_evidence === 'string' ? args.cached_code_evidence : '';
  if (quote.length > 2000 || !await employerMessageEvidence(ctx.page, quote)) {
    return { error: 'To reuse a recent emailed code or link, supply cached_code_evidence copied as a complete visible employer message establishing that the existing code/link is still valid. The quote could not be found on this page. No mailbox data was read.' };
  }
  // The agent judges whether the quoted employer instruction permits reuse.
  // Grounding relaxes only this flow's lower bound; Gmail retains its normal
  // fifteen-minute age cap and all account/sender/context checks.
  return {};
}

export async function doCompleteAuthentication(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  assertLive();
  const purpose = String(args.purpose ?? '');
  if (!['sign_in', 'create_account', 'reset_password'].includes(purpose)) return ok('Choose sign_in, create_account or reset_password from the observed form.', 'invalid-arguments');
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
  const fields = ctx.observation.fields.filter((field) => refs.includes(field.ref));
  const selected = new Map<string, Locator>();
  if (Array.isArray(args.targets)) await Promise.all(ctx.page.frames().map(frame => preparePrivateAuthenticationFields(frame)));
  if (Array.isArray(args.targets)) for (const [index, spec] of (args.targets as Record<string, unknown>[]).entries()) {
    const input = browserTarget(ctx.page, spec);
    const facts = await input.evaluate(node => {
      const element = node as HTMLInputElement;
      const privateKind = node.getAttribute('data-owtomate-private-auth') as 'password' | 'verification-code' | null;
      return { label: [...(element.labels || [])].map(label => label.textContent).join(' ') || node.getAttribute('aria-label') || element.name || '', inputType: element.type, sensitive: Boolean(privateKind), ...(privateKind ? { privateKind } : {}) };
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
   * was verifiably given when it was made or successfully reset.
   */
  const setsPassword = purpose === 'create_account' || purpose === 'reset_password';
  const site = hostOf(ctx.page.url());
  if (purpose === 'sign_in') ctx.pendingCredentials?.delete(site);
  /**
   * Proposals never authorize an existing-account sign-in. The agent must
   * record actual registration/reset acceptance before the new password is used.
   */
  const credential: SiteCredential | null = setsPassword
    ? { format: 'readable-v1', rules: normalizeRules(args.password_rules) }
    : storedCredential(ctx.page.url(), ctx.profile.email);
  const values = fields.map((field) => ({ field, value: authenticationValue(field, ctx.profile, ctx.page.url(), credential) }));
  const unsupported = values.filter((entry) => entry.value === null);
  const missingCredential = unsupported.some((entry) => isAuthenticationPasswordField(entry.field));
  if (missingCredential) {
    return ok('No verified usable password is available for this account and site. No credential was guessed or filled. Inspect supported registration, passwordless or authorized account recovery options; a previously existing account needs its real credential. Do not repeat the rejected sign-in or claim the candidate supplied a wrong password.', 'reobserve');
  }

  const filled: string[] = [];
  const filledRefs = new Set<string>();
  const failed: string[] = [];
  for (const { field, value } of values) {
    if (value === null) continue;
    try {
      assertLive();
      await (selected.get(field.ref) ?? browserTarget(ctx.page, { ref: field.ref })).fill(value, { timeout: 8000 });
      filled.push(field.label);
      filledRefs.add(field.ref);
    } catch {
      failed.push(field.label); // Browser errors can echo private fill values.
    }
  }

  /**
   * The candidate now has, or has used, an account they may never have heard
   * of. The purpose is the agent's own reading of the page; the password is
   * not recorded, because the dashboard can derive it again for its owner.
   */
  const credentialFilled = values.some(
    ({ field, value }) => value !== null && isAuthenticationPasswordField(field) && filledRefs.has(field.ref),
  );
  assertLive();
  if (filled.length) rememberAuthenticationStart(ctx, site);
  if (credentialFilled) {
    const email = ctx.profile.email;
    // Held until the site accepts it: a sign-up refused because the account already exists must not replace the password it has.
    if (setsPassword && credential) {
      (ctx.pendingCredentials ??= new Map()).set(site, credential);
    }
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

/** The applying agent reports the outcome; transport verifies fresh quoted
 * employer evidence and never promotes prepared fields into accepted login. */
export async function doRecordAuthenticationResult(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  assertLive();
  const purpose = String(args.purpose ?? ''), outcome = String(args.outcome ?? '');
  if (!['sign_in', 'create_account', 'reset_password'].includes(purpose)
    || !['accepted', 'rejected', 'needs_verification'].includes(outcome)) {
    return ok('Supply purpose and an explicit outcome: accepted, rejected or needs_verification. Nothing has been recorded.', 'invalid-arguments');
  }
  const evidence = await employerMessageEvidence(ctx.page, String(args.evidence ?? ''));
  if (!evidence) return ok('Copy the complete current employer message as evidence. Typed values, button labels and a narrative summary cannot establish authentication. Nothing has been recorded.', 'reobserve');
  if (outcome === 'accepted') {
    for (const frame of ctx.page.frames()) {
      if (frame !== ctx.page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue;
      await preparePrivateAuthenticationFields(frame);
      const passwordInputs = frame.locator('[data-owtomate-private-auth="password"]');
      for (const input of await passwordInputs.all()) {
        if (await input.isVisible() && await input.isEnabled()) {
          return ok('Authentication is still on an editable password form. Record rejected or needs_verification when appropriate, or inspect the actual authenticated account/application page before reporting accepted. No credential or success audit was saved.', 'reobserve');
        }
      }
    }
  }
  assertLive();
  const site = hostOf(ctx.page.url()), email = ctx.profile.email;
  const action = { site, email, purpose: purpose as 'sign_in' | 'create_account' | 'reset_password',
    at: new Date().toISOString(), detail: `Authentication ${outcome}: ${evidence.quote}` };
  if (outcome === 'rejected') {
    if (purpose === 'sign_in') rejectCredential(ctx.page.url(), email);
    ctx.pendingCredentials?.delete(site);
    ctx.actions.push({ ...action, kind: 'authentication-rejected' });
    // Retire the actual private value too; another click must not resubmit it.
    for (const frame of ctx.page.frames()) {
      if (frame !== ctx.page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue;
      await preparePrivateAuthenticationFields(frame);
      for (const input of await frame.locator('[data-owtomate-private-auth="password"]').all()) {
        try { assertLive(); if (await input.isVisible() && await input.isEnabled()) await input.fill('', { timeout: 1000 }); }
        catch { assertLive(); /* Detached inputs cannot be reused on the current page. */ }
      }
    }
    return ok('Recorded rejected authentication. This sign-in credential will not be reused. Account recovery or a confirmed new credential is required.', 'reobserve');
  }
  if (outcome === 'needs_verification') {
    ctx.actions.push({ ...action, kind: 'authentication-prepared' });
    return ok('Recorded pending verification. No account creation, reset or sign-in success was recorded and no new credential was retained.', 'reobserve');
  }
  const accepted = { ...action, kind: purpose === 'create_account' ? 'account-created' as const : purpose === 'reset_password' ? 'password-reset' as const : 'signed-in' as const };
  ctx.actions.push(accepted);
  commitAcceptedCredentials(ctx.pendingCredentials, [accepted], email);
  return ok('Recorded accepted authentication with current employer evidence.');
}

export async function fillEmailedCode(page: Page, fields: Observation['fields'], code: string, targets?: Locator[]): Promise<boolean> {
  if (!fields.length || new Set(fields.map(f => f.ref)).size !== fields.length) return false;
  if (fields.length > 1 && fields.length !== code.length) return false;
  const inputs = targets ?? fields.map(field => browserTarget(page, { ref: field.ref }));
  if (inputs.length !== fields.length) return false;
  const values = fields.length === 1 ? [code] : [...code];
  const handles: Array<ElementHandle<HTMLElement | SVGElement>> = [];
  try {
    // Repeated native targets can point to the same box even when their
    // synthetic refs differ. Validate every actual element before any fill.
    for (let i = 0; i < inputs.length; i++) {
      assertLive();
      if (await inputs[i].count() !== 1 || !await inputs[i].isVisible()) return false;
      const handle = await inputs[i].elementHandle();
      if (!handle) return false;
      for (const other of handles) if (await handle.evaluate((el, previous) => el === previous, other)) { await handle.dispose(); return false; }
      handles.push(handle);
      if (!await handle.evaluate((el, value) => {
        if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || el.type === 'hidden') return false;
        if (el.maxLength >= 0 && el.maxLength < value.length) return false;
        if (el.type === 'number' && !/^\d+$/.test(value)) return false;
        if (el.pattern) {
          try { if (!new RegExp(`^(?:${el.pattern})$`, 'v').test(value)) return false; } catch { /* Invalid patterns impose no browser constraint. */ }
        }
        return true;
      }, values[i])) return false;
    }
    assertLive();
    rememberPrivateAuthenticationValue(page, code);
    for (const handle of handles) await handle.evaluate(el => el.setAttribute('data-owtomate-private-auth', 'verification-code'));
    for (let i = 0; i < inputs.length; i++) {
      assertLive();
      await inputs[i].fill(values[i], { timeout: 5_000 });
      // The final digit can auto-advance the page; fresh observation verifies that.
      if (i < inputs.length - 1 && await inputs[i].inputValue() !== values[i]) return false;
    }
    return true;
  } finally { await Promise.all(handles.map(handle => handle.dispose().catch(() => {}))); }
}

const cannotReadMailbox = (error: string) => /reconnect|authorization|MCP could not|connect Gmail|Gmail.*(?:unavailable|could not|did not)|mailbox request/i.test(error);

export async function doEnterEmailedCode(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  assertLive();
  if (!VERIFICATION_PURPOSES.includes(args.purpose as VerificationPurpose)) return ok('Choose the requested email purpose: account_verification, sign_in or reset_password. No mailbox data was read.', 'invalid-arguments');
  const problem = mailboxProblem(ctx);
  if (problem) return ok(problem, 'failed');
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : [String(args.ref ?? '')];
  let fields = refs.map(ref => ctx.observation.fields.find(candidate => candidate.ref === ref));
  const targets = Array.isArray(args.targets) ? (args.targets as Record<string, unknown>[]).map(spec => browserTarget(ctx.page, spec)) : undefined;
  if (targets) fields = targets.map((_, index) => ({ ref: `private-code-${index}`, label: 'Verification code', kind: 'text', required: true }));
  if (!fields.length || fields.some(field => !field) || !targets && new Set(refs).size !== refs.length) return ok('Choose current code inputs using targets, or current FIELD refs in digit order.');
  const freshness = await verificationFreshness(ctx, args);
  assertLive();
  if (freshness.error !== undefined) return ok(freshness.error, 'invalid-arguments');
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification code');

  const site = hostOf(ctx.page.url());
  const found = await findVerificationInGmail({ hint, site, purpose: args.purpose as VerificationPurpose, want: 'code', allowAlternative: true, requestedAt: freshness.requestedAt, timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  assertLive();
  if (!('error' in found) && found.kind !== 'code') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a link, not a code. Call open_emailed_link instead.`);
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    if ('reason' in found && found.reason === 'unreadable-message') return ok(found.error, 'failed');
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
  ctx.log('  ✉ entered the emailed verification code');
  {
    const site = hostOf(ctx.page.url());
    noteAction(ctx, {
      kind: 'email-code',
      site,
      detail: `Used the verification code ${siteName(site)} emailed you.`,
    });
  }
  return ok('Entered the emailed code into the selected fields. Inspect the page to verify acceptance before continuing.');
}

/** How long the inbox is watched for a site's email before the agent is told to resend. */
const EMAIL_WAIT_MS = 120_000;

export async function doOpenEmailedLink(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  assertLive();
  if (!VERIFICATION_PURPOSES.includes(args.purpose as VerificationPurpose)) return ok('Choose the requested email purpose: account_verification, sign_in or reset_password. No mailbox data was read.', 'invalid-arguments');
  const problem = mailboxProblem(ctx);
  if (problem) return ok(problem, 'failed');
  const freshness = await verificationFreshness(ctx, args);
  assertLive();
  if (freshness.error !== undefined) return ok(freshness.error, 'invalid-arguments');
  const hint = typeof args.sender_hint === 'string' ? args.sender_hint : ctx.job.company;
  ctx.log('  ✉ waiting for the emailed verification link');
  const found = await findVerificationInGmail({ hint, site: hostOf(ctx.page.url()), purpose: args.purpose as VerificationPurpose, want: 'link', allowAlternative: true, requestedAt: freshness.requestedAt, timeoutMs: EMAIL_WAIT_MS, log: ctx.log });
  assertLive();
  if ('error' in found) {
    ctx.log(`  ✉ ${found.error}`);
    if ('reason' in found && found.reason === 'unreadable-message') return ok(found.error, 'failed');
    if (cannotReadMailbox(found.error)) return ok(`${found.error} This is a mailbox access failure, not a delayed email. Follow the mailbox recovery message before requesting another link.`);
    return ok(`${found.error} If the page has a resend control, click it and call this again once; otherwise finish with "skipped".`);
  }
  if (found.kind !== 'link') return ok(`The site's email ("${found.subject.slice(0, 60)}") carries a code, not a link. Call enter_emailed_code with the code field(s) instead.`);
  if (isForbiddenDestination(found.value)) return ok('The emailed link points somewhere this agent never navigates. Try another authentication option.');
  // A new tab keeps the form behind it intact; the loop follows the new tab.
  const tab = await ctx.page.context().newPage();
  try {
    assertLive();
    await tab.goto(found.value, { waitUntil: 'commit', timeout: 30_000 });
    assertLive();
  } catch {
    await tab.close().catch(() => {});
    return ok('The emailed link could not be opened. The application remains in its original tab. Inspect the browser connection before retrying.', 'failed');
  }
  ctx.page = tab;
  const site = hostOf(found.value);
  noteAction(ctx, { kind: 'email-code', site, detail: `Opened the verification link ${siteName(site)} emailed you ("${found.subject.slice(0, 60)}").` });
  ctx.log(`  ✉ opened the emailed link from "${found.subject.slice(0, 60)}"`);
  return ok('Opened the emailed link in a new tab; the application continues there. Inspect it: sign in or continue the application if the account is now verified.');
}
