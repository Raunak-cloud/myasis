import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const temporaryRoot = resolve(tmpdir());
const viteCache = mkdtempSync(join(temporaryRoot, 'owtomate-gmail-ui-vite-'));
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{GmailConnect}from"/src/components/GmailConnect.tsx";import{SeekSignIn}from"/src/components/SeekSignIn.tsx";import{PreparedApplications}from"/src/components/PreparedApplications.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.Fragment,null,React.createElement("details",null,React.createElement("summary",null,"Connect a job board"),React.createElement(SeekSignIn)),React.createElement("div",{style:{maxWidth:480,width:"100%",minWidth:0}},React.createElement(GmailConnect,{compact:new URLSearchParams(location.search).has("compact")})),React.createElement(PreparedApplications,{running:false,onStarted:()=>{},onCountChange:()=>{}})));</script><style>#fixture{display:grid;gap:18px;max-width:850px;width:100%;padding:16px;box-sizing:border-box;margin:auto}body{margin:0}</style></body></html>';
const server = await createServer({ configFile: false, root: dashboard, cacheDir: viteCache, plugins: [react(), { name: 'gmail-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/gmail-fixture.html') return next();
    res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/gmail-fixture.html', html));
  });
} }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
let captureFailure: (() => Promise<void>) | undefined;
try {
  mkdirSync(resolve(dashboard, '../output'), { recursive: true });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } }), page = await context.newPage();
    let connected = false, connects = 0, disconnects = 0, browserOpens = 0;
    let provider: 'browser' | 'mcp' = 'mcp', admin = false;
    let signin: object | null = null;
    let savedAccount: string | null = null, connectionError: string | null = null;
    let signinStatusUnavailable = false, holdNextStatus = false, heldStatusFails = false;
    let statusHeld!: () => void, releaseStatus!: () => void;
    let heldStatusStarted: Promise<void>, heldStatus: Promise<void>;
    const errors: string[] = [];
    const transportErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && transportErrors.length < 20) transportErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    page.on('requestfailed', request => { if (transportErrors.length < 20) transportErrors.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`); });
    captureFailure = async () => {
      const body = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '<body unavailable>');
      console.error('Gmail UI fixture failure:', JSON.stringify({ width, url: page.url(), errors, transportErrors, body: body.slice(0, 4000) }));
      await page.screenshot({ path: resolve(dashboard, `../output/gmail-ui-failure-${width}.png`), fullPage: true }).catch(() => {});
    };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/authorize-fixture') return route.fulfill({ contentType: 'text/html', body: '<h1>Google authorization fixture</h1>' });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/signin/session') {
        if (route.request().method() === 'GET' && signinStatusUnavailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Mailbox sign-in status temporarily unavailable' }) });
        if (route.request().method() === 'POST') {
          assert.equal(provider, 'browser'); const body = route.request().postDataJSON(); assert.equal(body.target, 'gmail'); assert.equal(body.consent, true); browserOpens++;
          signin = { id: 'gmail-fixture', target: 'gmail', state: 'starting', startedAt: Date.now(), expiresAt: Date.now() + 60_000, display: 0, password: 'fixture' };
        }
        if (route.request().method() === 'DELETE') { signin = null; connected = true; }
        return json({ supported: true, session: signin, seek: { signedIn: true }, indeed: { signedIn: true } });
      }
      if (url.pathname === '/api/gmail/status') {
        const snapshot = { connected, configured: true, account: savedAccount ?? (connected ? 'candidate@fixture.invalid' : null), error: connectionError, eligible: true, provider, admin, providers: admin ? ['browser','mcp'] : [provider] };
        if (holdNextStatus) {
          const fail = heldStatusFails; holdNextStatus = false; statusHeld(); await heldStatus;
          if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Outdated status request failed"}' });
        }
        return json(snapshot);
      }
      if (url.pathname === '/api/gmail/connect') { assert.equal(route.request().method(), 'POST'); connects++; return json({ url: origin + '/authorize-fixture' }); }
      if (url.pathname === '/api/gmail/connection') {
        if (route.request().method() === 'PATCH') { assert.equal(admin, true); provider = route.request().postDataJSON().provider; return json({ ok: true }); }
        assert.equal(route.request().method(), 'DELETE'); connected = false; disconnects++; return json({ ok: true });
      }
      if (url.pathname === '/api/settings') return json({ COVER_LETTER_INSTRUCTIONS: '' });
      if (url.pathname === '/api/application-reviews') return json({ applications: [{ id: 'review-fixture', status: 'ready', detail: null,
        application: { revision: 'a'.repeat(64), job: { title: 'Email Developer', company: 'Fixture', location: 'Sydney', url: 'https://jobs.fixture.invalid' },
          answers: [], coverLetter: 'Dear team,\n\nThe approved letter.', resume: 'CV.txt', email: { to: 'careers@fixture.invalid', subject: 'Developer application', attachCoverLetter: true } } }] });
      throw new Error('Unexpected fixture request: ' + url.pathname);
    });
    await page.goto(origin + '/gmail-fixture.html');
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
    await page.getByRole('heading', { name: 'Google authorization fixture' }).waitFor(); assert.equal(connects, 1);
    connected = true; await page.goto(origin + '/gmail-fixture.html?gmail=connected');
    await page.getByText('Connected: candidate@fixture.invalid', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reconnect Gmail', exact: true }).isEnabled(), true);
    await page.getByText('Review application', { exact: true }).click();
    await page.getByText('To: careers@fixture.invalid', { exact: false }).waitFor();
    assert.ok(await page.getByText('Subject: Developer application', { exact: false }).isVisible());
    assert.ok(await page.getByText('Attachments: resume and cover letter', { exact: false }).isVisible());
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Gmail and prepared email review fit mobile and desktop');
    await page.screenshot({ path: resolve(dashboard, `../output/gmail-mcp-${width}.png`), fullPage: true });
    holdNextStatus = true;
    heldStatusStarted = new Promise<void>(resolve => { statusHeld = resolve; });
    heldStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
    await page.evaluate(() => window.dispatchEvent(new Event('gmail-connection-changed')));
    await heldStatusStarted;
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor(); assert.equal(disconnects, 1);
    releaseStatus(); await page.waitForTimeout(50);
    assert.ok(await page.getByRole('button', { name: 'Connect Gmail', exact: true }).isVisible(), 'a late pre-disconnect status response cannot restore stale connected state');
    connected = true; await page.reload();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
    holdNextStatus = true; heldStatusFails = true;
    heldStatusStarted = new Promise<void>(resolve => { statusHeld = resolve; });
    heldStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
    await page.evaluate(() => window.dispatchEvent(new Event('gmail-connection-changed')));
    await heldStatusStarted;
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
    const staleFailure = page.waitForResponse(response => new URL(response.url()).pathname === '/api/gmail/status' && response.status() === 503);
    releaseStatus(); await staleFailure; await page.waitForTimeout(50);
    assert.equal(await page.getByRole('alert').count(), 0, 'a stale failed status request cannot add an error after a successful disconnect and current status load');
    assert.ok(await page.getByRole('button', { name: 'Connect Gmail', exact: true }).isVisible());
    heldStatusFails = false;
    await page.goto(origin + '/gmail-fixture.html?gmail=error&gmail_error=Authorization%20was%20denied');
    await page.getByRole('alert').filter({ hasText: 'Authorization was denied' }).waitFor();
    provider = 'browser'; await page.goto(origin + '/gmail-fixture.html');
    await page.getByRole('button', { name: 'Connect browser Gmail', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Gmail connection method').count(), 0, 'normal users have no MCP selector');
    signinStatusUnavailable = true;
    await page.getByRole('button', { name: 'Connect browser Gmail', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Mailbox sign-in status temporarily unavailable' }).waitFor();
    assert.equal(browserOpens, 0, 'a failed session-status read must not launch the desktop fallback');
    signinStatusUnavailable = false;
    await page.getByRole('button', { name: 'Connect browser Gmail', exact: true }).click();
    await page.getByRole('dialog', { name: 'Browser sign-in' }).waitFor({ state: 'visible' });
    assert.ok(await page.getByText('Gmail sign-in', { exact: true }).isVisible(), 'Gmail viewer is visible despite collapsed job-board settings');
    assert.equal(await page.locator('details').filter({ hasText: 'Connect a job board' }).getAttribute('open'), null);
    await page.screenshot({ path: resolve(dashboard, `../output/gmail-browser-signin-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('dialog', { name: 'Browser sign-in' }).waitFor({ state: 'hidden' });
    await page.getByText('Saved browser account: candidate@fixture.invalid', { exact: true }).waitFor();
    assert.equal(browserOpens, 1);
    connected = false;
    admin = true; await page.reload();
    await page.getByLabel('Gmail connection method').selectOption('mcp');
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
    await page.getByLabel('Gmail connection method').selectOption('browser');
    await page.getByRole('button', { name: 'Connect browser Gmail', exact: true }).waitFor();
    assert.ok(await page.getByText('The browser session can access the entire mailbox.', { exact: false }).isVisible());
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await page.screenshot({ path: resolve(dashboard, `../output/gmail-dual-${width}.png`), fullPage: true });
    admin = false; connected = false;
    savedAccount = 'candidate.long.email.address.for.mobile.layout@fixture.invalid';
    connectionError = `Connect browser Gmail to allow mailbox access for ${savedAccount}.`;
    await page.goto(origin + '/gmail-fixture.html?compact=1');
    const card = page.locator('.gmail-connect-card');
    await card.getByText(`Saved browser account: ${savedAccount}`, { exact: true }).waitFor();
    const layout = await card.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const description = element.children[0].getBoundingClientRect();
      const actions = element.querySelector('.gmail-actions')!;
      return {
        fullWidth: description.width > bounds.width * 0.8,
        stacked: description.bottom <= actions.getBoundingClientRect().top,
        contained: Array.from(actions.children).every(child => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.left >= bounds.left && childBounds.right <= bounds.right;
        }),
      };
    });
    assert.deepEqual(layout, { fullWidth: true, stacked: true, contained: true }, 'compact Gmail description and actions fit a narrow Apply column without overlap');
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await card.screenshot({ path: resolve(dashboard, `../output/gmail-compact-${width}.png`) });
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS: normal browser Gmail consent/sign-in, admin provider switching, OAuth connect/disconnect, callback errors, visible email recipient/subject/attachments, compact card without overlap at 320/390/1440px; no real mail.');
} catch (error) {
  await captureFailure?.();
  throw error;
} finally {
  await browser.close(); await server.close();
  if (dirname(viteCache) === temporaryRoot) rmSync(viteCache, { recursive: true, force: true });
  else console.error('Unexpected Gmail fixture cache path; temporary cache was retained.');
}
