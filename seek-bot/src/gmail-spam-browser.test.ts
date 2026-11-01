import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { registerGmailBrowser, searchBrowserGmail, readBrowserGmail } from './gmail-browser.js';
import { GmailMcpService } from './gmail-mcp-service.js';
import { doOpenEmailedLink } from './agent/authentication.js';
import { observe } from './agent/observe.js';
import type { ToolContext } from './agent/context.js';

// A real Chrome/CDP/MCP/local-parser round trip. All Gmail and employer pages
// are synthetic, and the sole activation message lives in simulated Spam.
const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as { port: number }).port; await new Promise<void>(done => listener.close(() => done()));
const directory = mkdtempSync(join(tmpdir(), 'owtomate-spam-browser-'));
const context = await chromium.launchPersistentContext(directory, { headless: true, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const names = ['GMAIL_MCP_URL', 'GMAIL_MCP_TOKEN', 'GMAIL_MCP_ACCOUNT', 'GMAIL_ACCESS_MODE'] as const;
const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
const queries: string[] = []; let openedActivation = 0;
context.on('page', page => page.on('framenavigated', frame => {
  if (frame === page.mainFrame() && frame.url().includes('#search/')) queries.push(decodeURIComponent(new URL(frame.url()).hash.slice('#search/'.length)));
}));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.hostname === 'dcj.fixture.invalid') {
    if (url.pathname === '/activate') openedActivation++;
    return route.fulfill({ contentType: 'text/html', body: '<main><p>Check your email to activate your account.</p></main>' });
  }
  assert.equal(url.hostname, 'mail.google.com', 'no real employer or other network request is allowed');
  return route.fulfill({ contentType: 'text/html', body: `<!doctype html><a aria-label="Google Account: candidate@fixture.invalid"></a><main role="main">
    <p>This message is in Spam.</p><table><tr data-legacy-thread-id="spamactivation"><td>Activate your DCJ account</td></tr></table>
    <h2>Activate your DCJ account</h2><article data-message-id="spammessage"><span email="donotreply@justice.fixture.invalid"></span><div class="a3s"><p>Activate your DCJ account.</p><a href="https://dcj.fixture.invalid/activate?token=private-fixture-token">Activate account</a></div></article></main>
    <script>const q=decodeURIComponent(location.hash.slice(8));if(location.hash.startsWith('#search/') && !(q.includes('in:anywhere') && q.includes('-in:trash') && !q.includes('-in:spam'))){document.querySelector('table').outerHTML='<p>No conversations found.</p>';}</script>` });
});
const stop = registerGmailBrowser('spam-browser-owner', port, 'candidate@fixture.invalid');
const service = new GmailMcpService({ search: searchBrowserGmail, thread: readBrowserGmail, send: async () => { throw Error('Read-only fixture cannot send email'); } });
const lease = await service.grant('spam-browser-owner', 'candidate@fixture.invalid');
Object.assign(process.env, { GMAIL_MCP_URL: lease.connection.url, GMAIL_MCP_TOKEN: lease.connection.token, GMAIL_MCP_ACCOUNT: lease.connection.account, GMAIL_ACCESS_MODE: 'browser' });
try {
  const page = await context.newPage(); await page.goto('https://dcj.fixture.invalid/registration');
  const ctx = { page, profile: { email: 'candidate@fixture.invalid' }, job: { company: 'DCJ' }, observation: await observe(page), actions: [], captured: [], log: () => {} } as unknown as ToolContext;
  const result = await doOpenEmailedLink(ctx, { purpose: 'account_verification', sender_hint: 'DCJ / justice.fixture.invalid' });
  assert.match(JSON.stringify(result), /Opened the emailed link/);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-token/, 'activation tokens stay private');
  assert.equal(new URL(ctx.page.url()).pathname, '/activate'); assert.equal(openedActivation, 1);
  assert.ok(queries.length > 0 && queries.every(query => query.includes('in:anywhere') && query.includes('-in:trash') && query.includes('-in:sent') && query.includes('-in:draft')));
  assert.ok(!ctx.actions.some(action => ['account-created', 'signed-in'].includes(action.kind)), 'opening an activation link alone does not declare account/sign-in success');
  console.log('PASS: Spam-only activation found through native Gmail browser, real MCP and private email tool; no real mailbox, messages or application sends.');
} finally {
  stop(); lease.revoke(); await service.close(); await context.close();
  for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true });
}
