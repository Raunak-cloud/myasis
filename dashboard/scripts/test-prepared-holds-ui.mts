/** Real component; synthetic drafts and intercepted local fixture APIs only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const html = '<!doctype html><html><body><div id="fixture"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{PreparedApplications}from"/src/components/PreparedApplications.tsx";const count=n=>document.documentElement.dataset.ready=String(n);createRoot(document.getElementById("fixture")).render(React.createElement(PreparedApplications,{running:false,onStarted:()=>{},onCountChange:count}));</script></body></html>';
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), { name: 'hold-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/hold-fixture.html') return next();
    res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html));
  });
} }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  const page = await browser.newPage(), errors: string[] = [], posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const draft = (id: string, held = false, status = 'ready') => ({ id, status, operator_hold: held ? { reason: 'A required candidate fact needs verification.' } : null,
    application: { revision: 'a'.repeat(64), job: { title: id, company: 'Synthetic employer', location: 'Sydney', url: 'https://fixture.invalid' }, answers: [], coverLetter: 'Synthetic letter' } });
  let applications = [draft('Ready'), draft('Held', true), draft('Failed held', true, 'failed')];
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') posts.push(route.request().url());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith('/application-reviews') ? { applications } : {}) });
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/hold-fixture.html`);
  await page.getByLabel('Select Ready at Synthetic employer', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Select Held at Synthetic employer', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('Select Failed held at Synthetic employer', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Needs review', { exact: true }).count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Retry application' }).count(), 0);
  assert.equal(await page.locator('html').getAttribute('data-ready'), '1');
  await page.getByLabel('Select Ready at Synthetic employer', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply to 1 job', exact: true }).waitFor();
  applications = [draft('Ready', true), ...applications.slice(1)];
  await page.waitForFunction(() => document.documentElement.dataset.ready === '0', { timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Apply to 1 job', exact: true }).count(), 0, 'a polled hold revokes stale selection');
  assert.equal(await page.getByLabel('Select Ready at Synthetic employer', { exact: true }).isChecked(), false);
  await page.locator('summary').filter({ hasText: 'Review application' }).first().click();
  assert.equal(await page.getByRole('button', { name: 'Edit cover letter', exact: true }).count(), 0);
  assert.deepEqual(posts, []); assert.deepEqual(errors, []);
  console.log('PASS: held ready/failed drafts cannot be selected, retried or edited; ready count excludes holds; refresh clears stale selection without a write.');
} finally { await browser.close(); await server.close(); }
