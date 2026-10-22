import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { GmailMcpClient } from './gmail-mcp-client.js';
import { GmailMcpService, GmailServiceError } from './gmail-mcp-service.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-gmail-mcp-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
const { doEnterEmailedCode, doOpenEmailedLink } = await import('./agent/tools/auth.js');
const { observe } = await import('./agent/observe.js');
const { findVerificationInGmail, gmailAvailable } = await import('./gmail-mailbox.js');
const originalFetch = globalThis.fetch;
let readKind = 'code', unavailable = false, sent = 0;
const approval = randomUUID(), revision = 'a'.repeat(64);
const service = new GmailMcpService({
  search: async user => {
    if (unavailable) throw new GmailServiceError('reconnect', 'Reconnect the fixture mailbox.');
    return [{ id: user }];
  },
  thread: async (user, id) => {
    assert.equal(id, user);
    return [{ id: `${user}-email`, subject: 'Verify application', date: new Date().toISOString(),
      plaintextBody: `Use ${user === 'owner-a' ? '482913' : '628731'} to verify your account.`,
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
    assert.ok(String(url).includes('chat/completions'), 'only the model endpoint is external; mailbox access stays on MCP');
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ email: 0, kind: readKind, code: '482913', link: 0 }) } }] });
  };
  const context = await browser.newContext(); let gmailPages = 0;
  await context.route('**/*', route => {
    if (route.request().url().includes('mail.google.com')) gmailPages++;
    return route.fulfill({ contentType: 'text/html', body: '<main><label>Code<input maxlength="6"></label></main>' });
  });
  const page = await context.newPage(); await page.goto('https://employer.mailbox.invalid/code');
  const ctx = { page, job: { company: 'Fixture' }, observation: await observe(page), log: () => {}, guards: { recordProgress() {} }, actions: [] } as unknown as Parameters<typeof doEnterEmailedCode>[0];
  const code = await doEnterEmailedCode(ctx, { ref: ctx.observation.fields[0].ref });
  assert.match(JSON.stringify(code), /Entered the emailed code/);
  assert.equal(await page.locator('input').inputValue(), '482913'); assert.equal(context.pages().length, 1);
  readKind = 'link';
  const link = await doOpenEmailedLink(ctx, {});
  assert.match(JSON.stringify(link), /Opened the emailed link/);
  assert.match(context.pages()[1].url(), /verified\/owner-a/); assert.equal(gmailPages, 0);
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
