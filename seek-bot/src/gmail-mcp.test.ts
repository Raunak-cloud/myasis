import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { GmailMcpClient } from './gmail-mcp-client.js';
import { GmailMcpService, GmailServiceError } from './gmail-mcp-service.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-gmail-mcp-'));
Object.assign(process.env, { DATA_DIR: directory, FORM_CORPUS_DIR: join(directory, 'corpus'), CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false', SITE_AUTH_SECRET: 'fixture-only-site-secret' });
const { doEnterEmailedCode, doOpenEmailedLink, doCompleteAuthentication, fillEmailedCode } = await import('./agent/authentication.js');
const { observe, renderObservation } = await import('./agent/observe.js');
const { nativeReadback, nativeSnapshot } = await import('./agent/native-browser.js');
const { findVerificationInGmail, gmailAvailable, verificationMessage, verificationMessageIsFresh } = await import('./gmail-mailbox.js');
const { readVerificationEmailsLocally } = await import('./verification-email-local.js');
for (const code of ['482913', 'A8X2K9P4']) {
  const email = verificationMessage({ id: 'html-only', subject: 'Fixture verification',
    htmlBody: `<p>Your Fixture verification code:</p><table><tr><td>${code}</td></tr></table><p>Code expires soon.</p><script>123456</script>` }, 0);
  assert.match(email.text, new RegExp(`${code}\\s+Code`));
  assert.equal(readVerificationEmailsLocally([email], { hint: 'Fixture', want: 'code' })?.value, code, 'HTML fallback preserves code boundaries and legitimate alphanumeric codes');
}
assert.equal(verificationMessage({ id: 'plain', plaintextBody: 'Exact plaintext\n482913', htmlBody: '<p>Other body</p>' }, 0).text, 'Exact plaintext\n482913');
const originalFetch = globalThis.fetch;
let unavailable = false, sent = 0, browserOrder = false, olderCodeBelowReply = false, staleCandidate = false, unorderedApi = false;
let malformedCode = false;
let cachedMessageAgeMs = 0;
const reads: string[] = [], queries: string[] = [];
const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const cutoff = Date.now() - 15 * 60_000;
assert.equal(verificationMessageIsFresh({ id: 'old', date: recent(16) }, cutoff), false);
assert.equal(verificationMessageIsFresh({ id: 'cached', date: recent(10) }, cutoff), true, 'recent cached codes remain available when no new request time is known');
assert.equal(verificationMessageIsFresh({ id: 'old-request', date: recent(5) }, Date.now() - 2 * 60_000), false);
assert.equal(verificationMessageIsFresh({ id: 'future', date: recent(-3) }, cutoff), false);
assert.equal(verificationMessageIsFresh({ id: 'sent', date: recent(0), labelIds: ['SENT'] }, cutoff), false);
assert.equal(verificationMessageIsFresh({ id: 'unknown' }, cutoff), false);
const approval = randomUUID(), revision = 'a'.repeat(64);
const service = new GmailMcpService({
  search: async (user, query) => {
    queries.push(query);
    if (unavailable) throw new GmailServiceError('reconnect', 'Reconnect the fixture mailbox.');
    if (browserOrder) return [{ id: 'browser-newest' }, { id: 'browser-older' }];
    return [{ id: user }];
  },
  thread: async (user, id) => {
    reads.push(id);
    if (browserOrder) {
      if (unorderedApi) return [{ id, subject: 'Fixture verification', date: recent(id === 'browser-newest' ? 3 : 2), plaintextBody: `Use ${id === 'browser-newest' ? '111222' : '729184'} to verify your Fixture account.` }];
      if (olderCodeBelowReply) {
        const code = { id, subject: 'Fixture verification', date: recent(id === 'browser-newest' ? 3 : 2), plaintextBody: `Use ${id === 'browser-newest' ? '111222' : '729184'} to verify your Fixture account.` };
        return id === 'browser-newest' ? [code, { id: 'reply', date: recent(1), subject: 'Thanks', plaintextBody: 'Thank you.' }] : [code];
      }
      if (id === 'browser-older' && staleCandidate) throw new Error('Unrelated thread must not be read after finding the newest verification.');
      return [{ id, subject: 'Fixture verification', plaintextBody: `Use ${id === 'browser-newest' ? '729184' : '111222'} to verify your Fixture account.` }];
    }
    assert.equal(id, user);
    return [{ id: `${user}-email`, subject: 'Fixture: verify application', date: new Date(Date.now() - cachedMessageAgeMs).toISOString(),
      plaintextBody: malformedCode ? 'Your Fixture verification code: 482913Code' : `Use ${user === 'owner-a' ? '482913' : '628731'} to verify your account.`,
      htmlBody: `<p>Verify</p><a href="https://employer.mailbox.invalid/verified/${user}?token=fixture">Verify account</a>` }];
  },
  send: async (user, id, version) => { assert.equal(user, 'owner-a'); assert.equal(id, approval); assert.equal(version, revision); sent++; return { messageId: 'fixture-message' }; },
});
const a = await service.grant('owner-a', 'a@fixture.invalid', [approval]);
const b = await service.grant('owner-b', 'b@fixture.invalid');
const clients = [new GmailMcpClient(a.connection), new GmailMcpClient(b.connection)];
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const messages = await Promise.all(clients.map(async client => {
    const threads = await client.search('verification'); return client.thread(threads[0].id);
  }));
  assert.match(messages[0][0].plaintextBody!, /482913/); assert.match(messages[1][0].plaintextBody!, /628731/);
  await assert.rejects(clients[0].thread('owner-b'), /Search this mailbox/);
  await assert.rejects(clients[1].sendApproved(approval, revision), /cannot send/);
  assert.equal(sent, 0);
  assert.equal((await clients[0].sendApproved(approval, revision)).messageId, 'fixture-message');
  assert.equal(sent, 1);
  const denied = await originalFetch(a.connection.url, { method: 'POST', headers: { Origin: 'https://untrusted.invalid', Authorization: `Bearer ${a.connection.token}` }, body: '{}' });
  assert.equal(denied.status, 401);
  const anonymous = await originalFetch(a.connection.url, { method: 'POST', body: '{}' }); assert.equal(anonymous.status, 401);
  Object.assign(process.env, { GMAIL_MCP_URL: a.connection.url, GMAIL_MCP_TOKEN: a.connection.token, GMAIL_MCP_ACCOUNT: a.connection.account });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
    throw new Error('Verification email content must not leave the local MCP service for an AI provider.');
  };
  const context = await browser.newContext(); let gmailPages = 0;
  let linkNavigationFails = false;
  await context.route('**/*', route => {
    if (route.request().url().includes('mail.google.com')) gmailPages++;
    if (linkNavigationFails && route.request().url().includes('/verified/')) return route.abort();
    return route.fulfill({ contentType: 'text/html', body: '<main><label>Code<input maxlength="6"></label></main>' });
  });
  const page = await context.newPage(); await page.goto('https://employer.mailbox.invalid/code');
  const ctx = { page, profile: { email: 'a@fixture.invalid' }, job: { company: 'Fixture' }, observation: await observe(page), log: () => {}, actions: [] } as unknown as Parameters<typeof doEnterEmailedCode>[0];
  const wrongMailbox = { ...ctx, profile: { email: 'b@fixture.invalid' } } as typeof ctx;
  const beforeWrongMailbox = reads.length;
  assert.match(JSON.stringify(await doEnterEmailedCode(wrongMailbox, { ref: ctx.observation.fields[0].ref })), /does not match this candidate profile/);
  assert.equal(reads.length, beforeWrongMailbox, 'a profile/mailbox mismatch is denied before any email is read');
  const code = await doEnterEmailedCode(ctx, { ref: ctx.observation.fields[0].ref });
  assert.match(JSON.stringify(code), /Entered the emailed code/);
  assert.equal(await page.locator('input').inputValue(), '482913'); assert.equal(context.pages().length, 1);
  const afterCode = await observe(page);
  assert.equal(afterCode.fields[0].privateKind, 'verification-code');
  assert.equal(afterCode.fields[0].currentValue, '[private credential]');
  assert.doesNotMatch(renderObservation(afterCode), /482913/, 'regular observation after private code entry cannot disclose the code while the employer keeps its form open');
  assert.doesNotMatch(JSON.stringify(await nativeReadback(page.locator('input'))), /482913/);
  assert.doesNotMatch(await nativeSnapshot(page), /482913/);
  await page.setContent('<main>' + Array.from({ length: 6 }, (_, i) => `<label>Digit ${i + 1}<input maxlength="1"></label>`).join('') + '</main>');
  ctx.observation = await observe(page); malformedCode = true;
  const mismatch = await doEnterEmailedCode(ctx, { refs: ctx.observation.fields.map(field => field.ref) });
  assert.match(JSON.stringify(mismatch), /10-character code.*6 individual code inputs/);
  assert.doesNotMatch(JSON.stringify(mismatch), /482913/, 'a format diagnostic must never disclose the private code');
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), Array(6).fill(''), 'a length mismatch cannot partially type or truncate the code');
  malformedCode = false;
  const selectedFields = ctx.observation.fields;
  assert.equal(await fillEmailedCode(page, selectedFields, '482913', selectedFields.map(() => page.locator('input').first())), false, 'duplicate native targets cannot partially overwrite one digit box');
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), Array(6).fill(''));
  await page.locator('input').last().evaluate(input => { (input as HTMLInputElement).pattern = '[A-Z]'; });
  assert.equal(await fillEmailedCode(page, selectedFields, '482913'), false, 'all per-character constraints are checked before any field is filled');
  assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), Array(6).fill(''));
  linkNavigationFails = true;
  const actionsBeforeLink = ctx.actions.length;
  const failedLink = await doOpenEmailedLink(ctx, {});
  assert.match(JSON.stringify(failedLink), /could not be opened/);
  assert.equal(ctx.page, page); assert.equal(context.pages().length, 1);
  assert.equal(ctx.actions.length, actionsBeforeLink, 'failed verification navigation must not record a successful link opening');
  linkNavigationFails = false;
  const link = await doOpenEmailedLink(ctx, {});
  assert.match(JSON.stringify(link), /Opened the emailed link/);
  assert.match(context.pages()[1].url(), /verified\/owner-a/); assert.equal(gmailPages, 0);
  ctx.page = page;
  await page.setContent('<main><label>Password<input type="text"></label></main>');
  ctx.profile = { ...ctx.profile, name: 'Fixture Candidate', phone: '0400000000' };
  ctx.observation = await observe(page);
  const passwordRef = ctx.observation.fields[0].ref;
  await doCompleteAuthentication(ctx, { refs: [passwordRef], purpose: 'create_account' });
  const proposedPassword = await page.locator('input').inputValue();
  assert.ok(ctx.pendingCredentials?.size, 'a password shown as text still prepares a private credential');
  await page.locator('input').fill('');
  const unavailableLogin = await doCompleteAuthentication(ctx, { refs: [passwordRef], purpose: 'sign_in' });
  assert.match(JSON.stringify(unavailableLogin), /No verified usable password/);
  assert.ok(proposedPassword.length >= 12);
  assert.equal(await page.locator('input').inputValue(), '', 'an unaccepted registration proposal cannot authorize a generated sign-in credential');
  assert.equal(ctx.pendingCredentials?.size, 0);
  const reuseMessage = 'Your existing emailed code and verification link are still valid for fifteen minutes. Use either to continue.';
  await page.setContent(`<main><p>${reuseMessage}</p><label>Code<input maxlength="6"></label></main>`);
  ctx.observation = await observe(page);
  cachedMessageAgeMs = 8 * 60_000;
  const readsBeforeInvented = reads.length;
  const inventedReuse = await doEnterEmailedCode(ctx, { ref: ctx.observation.fields[0].ref, allow_recent_cached: true, cached_code_evidence: 'The earlier emailed code is reusable for thirty minutes.' });
  assert.match(JSON.stringify(inventedReuse), /quote could not be found/);
  const inventedLinkReuse = await doOpenEmailedLink(ctx, { allow_recent_cached: true, cached_code_evidence: 'The earlier emailed verification link is reusable for thirty minutes.' });
  assert.match(JSON.stringify(inventedLinkReuse), /quote could not be found/);
  assert.equal(reads.length, readsBeforeInvented, 'invented cached-code/link evidence is rejected before mailbox reads');
  assert.equal(await page.locator('input').inputValue(), '');
  const reusedCode = await doEnterEmailedCode(ctx, { ref: ctx.observation.fields[0].ref, allow_recent_cached: true, cached_code_evidence: reuseMessage });
  assert.match(JSON.stringify(reusedCode), /Entered the emailed code/);
  assert.equal(await page.locator('input').inputValue(), '482913', 'the exact current employer quote permits a still-valid eight-minute cached code');
  const reusedLink = await doOpenEmailedLink(ctx, { allow_recent_cached: true, cached_code_evidence: reuseMessage });
  assert.match(JSON.stringify(reusedLink), /Opened the emailed link/);
  await ctx.page.close(); ctx.page = page;
  cachedMessageAgeMs = 0;
  browserOrder = true;
  process.env.GMAIL_ACCESS_MODE = 'browser';
  const ordered = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 1000 });
  assert.ok(!('error' in ordered) && ordered.value === '729184', 'browser verification uses the newest search result, not the last email fetched');
  reads.length = 0; staleCandidate = true;
  const immediate = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 1000 });
  assert.ok(!('error' in immediate) && immediate.value === '729184');
  assert.deepEqual(reads, ['browser-newest'], 'a later failing thread cannot discard an already verified newest result');
  assert.ok(queries.at(-1)?.includes('"fixture"'), 'mailbox search uses the same relevance context as local parsing');
  staleCandidate = false; olderCodeBelowReply = true;
  const dated = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 1000 });
  assert.ok(!('error' in dated) && dated.value === '729184', 'a recent unrelated reply must not make an older code win');
  olderCodeBelowReply = false;
  unorderedApi = true; reads.length = 0; process.env.GMAIL_ACCESS_MODE = 'mcp';
  const apiOrder = await findVerificationInGmail({ hint: 'Fixture', want: 'code', timeoutMs: 1000 });
  assert.ok(!('error' in apiOrder) && apiOrder.value === '729184', 'API results without a guaranteed thread order still compare delivery times');
  assert.deepEqual(reads, ['browser-newest', 'browser-older']);
  unorderedApi = false; delete process.env.GMAIL_ACCESS_MODE;
  browserOrder = false;
  unavailable = true;
  const failure = await findVerificationInGmail({ timeoutMs: 1000 });
  assert.ok('error' in failure && /Reconnect Gmail/.test(failure.error));
  a.revoke(); await assert.rejects(clients[0].search('verification'), /could not be reached/);
  delete process.env.GMAIL_MCP_TOKEN;
  assert.equal(gmailAvailable(), false, 'there is no browser-session fallback');
  console.log('PASS: real MCP transport, account isolation, approval-scoped sending, code entry, emailed link handoff, revoked grants, origin checks and zero Gmail browser tabs.');
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all(clients.map(client => client.close())); await service.close(); await browser.close(); rmSync(directory, { recursive: true, force: true });
}
