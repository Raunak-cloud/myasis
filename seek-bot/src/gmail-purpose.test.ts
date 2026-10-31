import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { GmailMcpService } from './gmail-mcp-service.js';
import type { GmailMessage } from './gmail-mcp-client.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-mail-purpose-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
const queries: string[] = [];
let messages: GmailMessage[] = [];
const service = new GmailMcpService({
  search: async (_owner, query) => { queries.push(query); return [{ id: 'same-employer-thread' }]; },
  thread: async () => messages,
  send: async () => { throw new Error('Fixture must never send email'); },
});
const grant = await service.grant('fixture-purpose-owner', 'candidate@fixture.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: grant.connection.url, GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
const { findVerificationInGmail } = await import('./gmail-mailbox.js');
const { doOpenEmailedLink } = await import('./agent/authentication.js');
const { authenticationTools } = await import('./agent/auth-tools.js');
const { observe } = await import('./agent/observe.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const activation: GmailMessage = { id: 'activation', subject: 'Fixture account activation', date: new Date().toISOString(), sender: 'Fixture <noreply@fixture.invalid>', htmlBody: '<p>Activate your Fixture account using this activation link.</p><a href="https://fixture.invalid/activate?hash=private-activation">Activate account</a>' };
  const reset: GmailMessage = { id: 'reset', subject: 'Fixture: reset your password', date: new Date(Date.now() - 1000).toISOString(), sender: 'Fixture <noreply@fixture.invalid>', htmlBody: '<p>Reset your Fixture password.</p><a href="https://fixture.invalid/reset?hash=private-reset">Reset password</a>' };
  messages = [activation];
  const absent = await findVerificationInGmail({ hint: 'Fixture', want: 'link', purpose: 'reset_password', allowAlternative: true, timeoutMs: 150 });
  assert.ok('error' in absent, 'activation-only mail cannot falsely complete password recovery, including alternative-format fallback');
  messages = [activation, reset];
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname === 'fixture.invalid' ? route.fulfill({ contentType: 'text/html', body: '<main><p>Check your email to continue.</p></main>' }) : route.abort());
  for (const [purpose, expected] of [['reset_password', '/reset'], ['account_verification', '/activate']] as const) {
    const page = await context.newPage(); await page.goto('https://fixture.invalid/login');
    const ctx = { page, profile: { email: 'candidate@fixture.invalid' }, job: { company: 'Fixture' }, observation: await observe(page), actions: [], log: () => {} } as unknown as Parameters<typeof doOpenEmailedLink>[0];
    const result = await doOpenEmailedLink(ctx, { purpose, sender_hint: 'Fixture' });
    assert.match(JSON.stringify(result), /Opened the emailed link/);
    assert.equal(new URL(ctx.page.url()).pathname, expected, 'the private tool must open the requested flow, regardless of newest same-employer mail');
    assert.doesNotMatch(JSON.stringify(result), /private-activation|private-reset/, 'private link tokens stay outside model-visible tool output');
    await ctx.page.close(); await page.close();
  }
  assert.ok(queries.some(query => query.includes('(password OR reset OR recovery)')), 'password-recovery mailbox search is narrowed to that operation');
  for (const name of ['open_emailed_link', 'enter_emailed_code']) assert.ok((authenticationTools().find(tool => tool.name === name)!.parameters.required as string[]).includes('purpose'));
  console.log('PASS: wrong-purpose mail cannot satisfy recovery; actual private link tool opens reset/activation independently using a mock mailbox and isolated browser. No candidate mail or application.');
} finally {
  await browser.close(); grant.revoke(); await service.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true });
}
