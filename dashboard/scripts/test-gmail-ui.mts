import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{GmailConnect}from"/src/components/GmailConnect.tsx";import{PreparedApplications}from"/src/components/PreparedApplications.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.Fragment,null,React.createElement(GmailConnect),React.createElement(PreparedApplications,{running:false,onStarted:()=>{},onCountChange:()=>{}})));</script><style>#fixture{display:grid;gap:18px;max-width:850px;width:100%;padding:16px;box-sizing:border-box;margin:auto}body{margin:0}</style></body></html>';
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), { name: 'gmail-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/gmail-fixture.html') return next();
    res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/gmail-fixture.html', html));
  });
} }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  mkdirSync(resolve(dashboard, '../output'), { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 } }), page = await context.newPage();
    let connected = false, connects = 0, disconnects = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/authorize-fixture') return route.fulfill({ contentType: 'text/html', body: '<h1>Google authorization fixture</h1>' });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/signin/session') throw new Error('Gmail must never open a browser sign-in session');
      if (url.pathname === '/api/gmail/status') return json({ connected, configured: true, account: connected ? 'candidate@fixture.invalid' : null, eligible: true });
      if (url.pathname === '/api/gmail/connect') { assert.equal(route.request().method(), 'POST'); connects++; return json({ url: origin + '/authorize-fixture' }); }
      if (url.pathname === '/api/gmail/connection') { assert.equal(route.request().method(), 'DELETE'); connected = false; disconnects++; return json({ ok: true }); }
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
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor(); assert.equal(disconnects, 1);
    await page.goto(origin + '/gmail-fixture.html?gmail=error&gmail_error=Authorization%20was%20denied');
    await page.getByRole('alert').filter({ hasText: 'Authorization was denied' }).waitFor();
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS: Gmail OAuth connect/disconnect, callback errors, visible email recipient/subject/attachments, mobile/desktop layout; no Gmail browser-session requests and no real mail.');
} finally { await browser.close(); await server.close(); }
