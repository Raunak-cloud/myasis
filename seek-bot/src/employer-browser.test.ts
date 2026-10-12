import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

// Local browser and fixture documents only: no service or employer receives data.
const directory = mkdtempSync(join(tmpdir(), 'owtomate-cloud-browser-fixture-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.EMPLOYER_BROWSER_PROVIDER = 'brightdata';
process.env.BRIGHTDATA_ADMIN_ENABLED = 'true';
process.env.BRIGHTDATA_BROWSER_ENABLED = 'true';
process.env.BRIGHTDATA_BROWSER_USERNAME = 'brd-customer-fixture-zone-admin';
process.env.BRIGHTDATA_BROWSER_PASSWORD = 'fixture-only-private-password';
const { openEmployerBrowser, applicationBrowserName, applicationUpload, selectRemotePage, solveRemoteCaptcha } = await import('./employer-browser.js');
const { readRemoteBrowserPreview, LIVE_VIEW_REQUEST_FILE, REMOTE_PREVIEW_FILE } = await import('./remote-browser-preview.js');
const { doCompleteAuthentication } = await import('./agent/tools/auth.js');
const launch = () => chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
const localBrowser = await launch();
const localContext = await localBrowser.newContext();
await localContext.addCookies([{ name: 'private-account', value: 'local-only', url: 'https://fixture.example.test' }]);
const localPage = await localContext.newPage();
let remote: Awaited<ReturnType<typeof openEmployerBrowser>> | undefined;
let solverCalls = 0;
let solverError: Error | undefined;
const autoSolveChoices: boolean[] = [];
try {
  process.env.BRIGHTDATA_ADMIN_ENABLED = 'false';
  await assert.rejects(openEmployerBrowser(localPage, async () => { throw new Error('Unauthorized connection reached provider'); }), /administrator pilot/);
  process.env.BRIGHTDATA_ADMIN_ENABLED = 'true';
  await assert.rejects(openEmployerBrowser(localPage, async endpoint => { throw new Error(endpoint); }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /connection failed/);
    assert.ok(!error.message.includes('fixture-only-private-password')); return true;
  });
  remote = await openEmployerBrowser(localPage, async endpoint => {
    assert.equal(new URL(endpoint as string).hostname, 'brd.superproxy.io');
    const owned = await launch();
    const context = await owned.newContext();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async target => {
      const session = await originalSession(target);
      const send = session.send.bind(session);
      session.send = (async (method: string, params: unknown) => {
        if (method === 'Captcha.setAutoSolve') {
          const settings = params as { autoSolve: boolean; options: unknown };
          autoSolveChoices.push(settings.autoSolve);
          assert.deepEqual(settings.options, [{ type: 'hcaptcha', submit_form: false }, { type: 'usercaptcha', submit_form: false }]);
          return {};
        }
        if (method === 'Captcha.solve') {
          assert.deepEqual(params, { detectTimeout: 30_000, options: [{ type: 'hcaptcha', submit_form: false }, { type: 'usercaptcha', submit_form: false }] });
          solverCalls++;
          if (solverError) throw solverError;
          return { status: solverCalls < 3 ? 'solve_failed' : 'solve_finished' };
        }
        return send(method as never, params as never);
      }) as typeof session.send;
      return session;
    };
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Cloud browser fixture</h1><label>Resume<input type=file></label></main>' }));
    return owned;
  });
  assert.equal(applicationBrowserName(remote.page), 'brightdata');
  const credentialsRefused = await doCompleteAuthentication({ page: remote.page } as Parameters<typeof doCompleteAuthentication>[0], { refs: ['password'], purpose: 'sign_in' });
  assert.equal(credentialsRefused.kind, 'terminal', 'cloud pilot stops before accessing any private employer credential');
  assert.equal((await remote.page.context().cookies()).length, 0);
  await remote.page.goto('https://fixture.example.test/apply?candidate=private-token');
  const fixtureDocument = join(directory, 'Fixture resume.txt');
  writeFileSync(fixtureDocument, 'Fixture resume bytes');
  const payload = await applicationUpload(remote.page, fixtureDocument);
  assert.ok(typeof payload !== 'string');
  assert.equal(payload.name, 'Fixture resume.txt'); assert.equal(payload.mimeType, 'text/plain');
  await remote.page.getByLabel('Resume').setInputFiles(payload);
  assert.equal(await remote.page.getByLabel('Resume').evaluate((el: HTMLInputElement) => el.files?.[0]?.size), 20);
  assert.equal(await applicationUpload(localPage, fixtureDocument), fixtureDocument);
  assert.equal(selectRemotePage(localPage), false);
  assert.equal(selectRemotePage(remote.page), true);
  const address = remote.page.url();
  await remote.page.evaluate(() => { document.title = 'CAPTCHA fixture'; });
  assert.equal(await solveRemoteCaptcha(remote.page), true);
  assert.equal(solverCalls, 3);
  assert.deepEqual(autoSolveChoices, [true, false], 'the explicit retries take ownership and never re-enable background attempts');
  assert.equal(remote.page.url(), address, 'no solver retry reloads or navigates the application');
  assert.equal(await remote.page.getByLabel('Resume').evaluate((el: HTMLInputElement) => el.files?.[0]?.size), 20, 'the same uploaded form survives the retries');
  solverError = new Error('Protocol error (Captcha.solve): solver unavailable at wss://user:fixture-only-private-password@brd.superproxy.io:9222/; password=fixture-only-private-password');
  const diagnostics: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { diagnostics.push(values.join(' ')); };
  try { assert.equal(await solveRemoteCaptcha(remote.page), false); }
  finally { console.log = originalLog; }
  assert.equal(solverCalls, 4, 'a failed request is captured without launching overlapping retries');
  assert.match(diagnostics.join('\n'), /request_failed.*elapsedMs.*Protocol error.*solver unavailable/);
  assert.ok(!diagnostics.join('\n').includes('fixture-only-private-password'));
  assert.ok(!diagnostics.join('\n').includes('superproxy.io'));
  await remote.page.evaluate(() => { document.title = 'Cloud browser fixture'; });
  writeFileSync(join(directory, LIVE_VIEW_REQUEST_FILE), JSON.stringify({ at: Date.now() }));
  const frame = await new Promise<NonNullable<ReturnType<typeof readRemoteBrowserPreview>>>((done, fail) => {
    const timer = setInterval(() => {
      const frame = readRemoteBrowserPreview(directory);
      if (frame?.data) { clearInterval(timer); clearTimeout(deadline); done(frame); }
    }, 100);
    const deadline = setTimeout(() => { clearInterval(timer); fail(new Error('No fixture screenshot')); }, 7_000);
  });
  assert.equal(frame.url, 'https://fixture.example.test');
  assert.ok(!JSON.stringify(frame).includes('private-token'));
  assert.ok(Buffer.from(frame.data!, 'base64').length > 100);
  await remote.close(); remote = undefined;
  assert.equal(existsSync(join(directory, REMOTE_PREVIEW_FILE)), false);
  assert.equal((await localContext.cookies())[0]?.value, 'local-only');
  console.log('PASS: provider diagnostics retain errors and redact credentials; sessions isolate cookies; remote document bytes upload; owned live preview omits URL tokens; close removes preview');
} finally {
  await remote?.close(); await localBrowser.close();
  rmSync(directory, { recursive: true });
}
