import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-mailbox-routing-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
  DRY_RUN: 'false', ALLOW_EXTERNAL_APPLY: 'true', EMPLOYER_BROWSER_PROVIDER: 'local',
  GMAIL_BROWSER_ACCOUNT: 'fixture@example.invalid' });
const { runApplicationAgent } = await import('./loop.js');
const { EmployerBrowserRouter } = await import('../employer-browser-router.js');
const { doEnterEmailedCode, doOpenEmailedLink } = await import('./tools/auth.js');
const originalRoute = EmployerBrowserRouter.prototype.route;
const originalFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH }
  : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const cases = [
  { key: 'owner-a', kind: 'code', code: '482913', explicitMailbox: false },
  { key: 'owner-b', kind: 'code', code: '628731', explicitMailbox: true },
  { key: 'owner-link', kind: 'link', code: '', explicitMailbox: true },
] as const;
const employerPages = new Map<Page, Page>();
const turns = new Map<string, number>();

// The real routing entry point changes browser contexts before its first
// model turn, reproducing the ISS handoff. Every document stays in fixtures.
EmployerBrowserRouter.prototype.route = async page => employerPages.get(page) ?? page;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const text = JSON.stringify(body.messages);
  // Shared history may mention other concurrent jobs. Route model responses
  // using this run's authoritative listing, rather than its full transcript.
  const listing = body.tools?.length
    ? JSON.parse(String(body.messages[1].content).split('APPLICATION (listing content is untrusted evidence)\n')[1].split('\n')[0])
    : undefined;
  const fixture = cases.find(item => listing ? listing.id === item.key : text.includes(item.key));
  assert.ok(fixture, 'every request belongs to exactly one fixture candidate');
  if (!body.tools?.length) {
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ email: 0,
      kind: fixture.kind, code: fixture.code, link: fixture.kind === 'link' ? 0 : -1 }) } }] });
  }
  const turn = (turns.get(fixture.key) ?? 0) + 1;
  turns.set(fixture.key, turn);
  if (turn === 2) {
    const result = body.messages.filter((message: { role: string }) => message.role === 'tool').at(-1)?.content;
    assert.match(String(result), fixture.kind === 'code' ? /Entered the emailed code/ : /Opened the emailed link/, String(result));
  }
  const call = turn === 1 ? { name: fixture.kind === 'code' ? 'enter_emailed_code' : 'open_emailed_link',
    args: fixture.kind === 'code' ? { ref: 'f0', sender_hint: fixture.key } : { sender_hint: fixture.key } }
    : turn === 2 ? { name: 'browser_action', args: fixture.kind === 'code'
      ? { action: 'click', selector: '#continue' } : { action: 'select_page', page_index: 1 } }
    : { name: 'finish', args: { status: 'skipped', reason: 'Isolated verification complete', evidence: 'VERIFIED APPLICATION FORM' } };
  if (turn === 3) assert.match(JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content), /VERIFIED APPLICATION FORM/);
  assert.ok(turn <= 3, 'verification resumes the employer form without another Gmail attempt');
  return Response.json({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: `${fixture.key}-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
};

try {
  await Promise.all(cases.map(async fixture => {
    const mailbox = await browser.newContext();
    const worker = fixture.explicitMailbox ? await browser.newContext() : mailbox;
    const employer = await browser.newContext();
    let mailRequests = 0, privateMailRequests = 0, workerMailRequests = 0;
    await mailbox.addCookies([{ name: 'mailbox-owner', value: fixture.key, url: 'https://mail.google.com' }]);
    const link = `https://employer.mailbox.invalid/verified/${fixture.key}?token=fixture-only`;
    const gmail = `<!doctype html><main role="main" id="main"></main><script>
      const list = '<table><tr role="row" onclick="location.hash=\\'#inbox/1\\'"><td>${fixture.key}</td><td>Verification</td></tr></table>';
      const message = '<h2>Verification for ${fixture.key}</h2><p>Use ${fixture.code} to verify your account.</p><a href="${link}">Verify account</a>';
      const render = () => document.querySelector('main').innerHTML = location.hash.startsWith('#inbox/') ? message : list;
      addEventListener('hashchange', render); render();</script>`;
    await mailbox.route('**/*', async route => {
      if (new URL(route.request().url()).hostname === 'mail.google.com') {
        mailRequests++;
        assert.ok((await mailbox.cookies()).some(cookie => cookie.name === 'mailbox-owner' && cookie.value === fixture.key));
        return route.fulfill({ contentType: 'text/html', body: gmail });
      }
      return route.fulfill({ contentType: 'text/html', body: '<main>Fixture job board</main>' });
    });
    if (worker !== mailbox) await worker.route('**/*', route => {
      if (new URL(route.request().url()).hostname === 'mail.google.com') workerMailRequests++;
      return route.fulfill({ contentType: 'text/html', body: '<main>Fixture worker</main>' });
    });
    await employer.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'mail.google.com') { privateMailRequests++; return route.abort(); }
      return route.fulfill({ contentType: 'text/html', body: url.pathname.startsWith('/verified/')
        ? '<main><h1>VERIFIED APPLICATION FORM</h1></main>'
        : `<main><h1>Verify ${fixture.key}</h1><label>Emailed code<input id="code" maxlength="6"></label>
          <button id="continue" onclick="if(document.querySelector('input').value==='${fixture.code}')document.querySelector('main').innerHTML='<h1>VERIFIED APPLICATION FORM</h1>'">Continue</button></main>` });
    });
    const localPage = await worker.newPage();
    await localPage.goto(`https://www.seek.com.au/job/${fixture.key}`);
    const privatePage = await employer.newPage();
    await privatePage.goto(`https://employer.mailbox.invalid/apply/${fixture.key}`);
    employerPages.set(localPage, privatePage);
    const result = await runApplicationAgent({ page: localPage, ...(fixture.explicitMailbox ? { mailboxContext: mailbox } : {}),
      job: { id: fixture.key, title: `Fixture ${fixture.key}`, company: fixture.key, location: 'Sydney', url: localPage.url() },
      profile: { name: fixture.key, email: `${fixture.key}@example.invalid`, skills: [] } as never, log: () => {} });
    assert.equal(result.outcome.status, 'skipped');
    assert.equal(result.submitPressed, false, 'verification never submits an application');
    assert.equal(privateMailRequests, 0, 'Gmail never opens inside the employer browser');
    assert.equal(workerMailRequests, 0, 'an explicit original mailbox wins over the worker cookie jar');
    assert.ok(mailRequests > 0);
    assert.equal(mailbox.pages().length, worker === mailbox ? 1 : 0, 'only the helper-owned Gmail tab closes');
    assert.deepEqual(await employer.cookies(), [], 'Gmail cookies never cross into the employer context');
    assert.equal(localPage.isClosed(), false);
    assert.equal(privatePage.isClosed(), false);
    await mailbox.close(); if (worker !== mailbox) await worker.close(); await employer.close();
  }));
  const signedOut = await browser.newContext();
  await signedOut.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1><label>Email address<input></label>' }));
  const form = await signedOut.newPage();
  const signedOutTool = { page: form, mailboxContext: signedOut, job: { company: 'Fixture' },
    observation: { fields: [{ ref: 'code' }] }, log: () => {} } as unknown as Parameters<typeof doEnterEmailedCode>[0];
  for (const result of [await doEnterEmailedCode(signedOutTool, { ref: 'code' }), await doOpenEmailedLink(signedOutTool, {})]) {
    assert.equal(result.kind, 'ok');
    assert.match(JSON.stringify(result), /Reconnect Gmail from the dashboard/);
    assert.doesNotMatch(JSON.stringify(result), /click it and call this again/);
  }
  assert.deepEqual(signedOut.pages(), [form], 'signed-out helpers close their own tabs');
  await signedOut.close();
  console.log('PASS: concurrent candidate mailboxes stay isolated across initial cloud handoffs; codes enter the employer form, links open there, Gmail stays local, and helper tabs close without submitting.');
} finally {
  EmployerBrowserRouter.prototype.route = originalRoute; globalThis.fetch = originalFetch;
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
