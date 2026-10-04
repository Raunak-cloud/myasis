import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

/**
 * Waiting for a site's email ends as soon as waiting longer cannot help.
 * Up to 4 Oct, 21 of 87 email waits ran the full two minutes: a Gmail tab
 * stuck on about:blank that a reload could never reach, and waits for a link
 * when the site had emailed a code.
 */
const directory = mkdtempSync(join(tmpdir(), 'owtomate-email-wait-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
// The model reads the one email as the site's, carrying a code.
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ email: 0, kind: 'code', code: '482913', link: -1 }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const { findVerificationInBrowser } = await import('./browser-gmail.js');

// A minimal Gmail: a list of rows; opening one shows its message, Back returns to the list.
const gmail = `<!doctype html><body><div role="main" id="main"></div><script>
  const list = '<table><tr role="row" onclick="location.hash=\\'#inbox/1\\'"><td>Careers Fixture</td><td>Your verification code</td></tr></table>';
  const message = '<h2>Your verification code</h2><div>Use 482913 to verify your account.</div>';
  const render = () => { document.getElementById('main').innerHTML = location.hash.startsWith('#inbox/') ? message : list; };
  addEventListener('hashchange', render); render();
</script></body>`;

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  // 1. The first navigation fails and leaves about:blank; the wait reopens Gmail and finds the code.
  let context = await browser.newContext();
  let attempts = 0;
  await context.route('https://mail.google.com/**', (route) => (++attempts === 1 ? route.abort() : route.fulfill({ contentType: 'text/html', body: gmail })));
  let started = Date.now();
  let found = await findVerificationInBrowser(context, { hint: 'Careers Fixture', site: 'careers.fixture.example', want: 'code', timeoutMs: 120_000 });
  assert.ok(!('error' in found) && found.kind === 'code' && found.value === '482913', JSON.stringify(found));
  assert.ok(attempts >= 2, 'Gmail was opened again after the failed navigation');
  assert.ok(Date.now() - started < 30_000, `recovered quickly (${Date.now() - started} ms)`);
  await context.close();

  // 2. Waiting for a link when the site emailed a code: told within the grace, not after two minutes.
  context = await browser.newContext();
  await context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: gmail }));
  started = Date.now();
  found = await findVerificationInBrowser(context, { hint: 'Careers Fixture', site: 'careers.fixture.example', want: 'link', timeoutMs: 120_000 });
  assert.ok(!('error' in found) && found.kind === 'code', `the other kind is reported: ${JSON.stringify(found)}`);
  assert.ok(Date.now() - started < 60_000, `reported well inside the wait (${Date.now() - started} ms)`);
  await context.close();

  // 3. A Gmail that never shows its mailbox is given up on early.
  context = await browser.newContext();
  await context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Loading…</p>' }));
  started = Date.now();
  found = await findVerificationInBrowser(context, { hint: 'Careers Fixture', site: 'careers.fixture.example', want: 'code', timeoutMs: 120_000 });
  assert.ok('error' in found && /did not finish loading/.test(found.error), JSON.stringify(found));
  assert.ok(Date.now() - started < 75_000, `gave up early (${Date.now() - started} ms)`);
  await context.close();

  console.log('PASS: a failed Gmail navigation is retried, an email of the other kind is reported within the grace, and a Gmail that never loads is given up on early');
} finally {
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
