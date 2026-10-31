/** Actual components in Chrome; every API and all external traffic are fixture-only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { EMPTY_PROFILE } from '../server/candidate-profile.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const application = { jobId: 'fixture-job', title: 'Fixture Engineer', company: 'Fixture Employer', location: 'Sydney', url: 'https://example.test/fixture', appliedAt: new Date().toISOString(), score: 90, platform: 'seek' };
const html = `<!doctype html><html><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{ProfileForm}from"/src/components/ProfileForm.tsx";import{SetupPanel}from"/src/components/SetupPanel.tsx";import{ApplicationsPanel}from"/src/components/ApplicationsPanel.tsx";import"/src/index.css";function Apps(){const[apps,setApps]=React.useState([${JSON.stringify(application)}]);return React.createElement(ApplicationsPanel,{apps,onChange:setApps,followUpDays:10});}const params=new URLSearchParams(location.search);createRoot(document.getElementById("fixture")).render(React.createElement(React.StrictMode,null,params.has("applications")?React.createElement(Apps):params.has("settings")?React.createElement(SetupPanel,{inline:true,initialStep:"looking"}):React.createElement(ProfileForm)));</script></body></html>`;
const server = await createServer({ configFile: false, root: dashboard, cacheDir: resolve(dashboard, 'node_modules/.vite-settings-ui'), plugins: [react(), {
  name: 'settings-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/settings-fixture.html') return next();
      res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/settings-fixture.html', html));
    });
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
let failures = 0;
async function check(name: string, run: (page: import('../../seek-bot/node_modules/patchright/index.js').Page, errors: string[]) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(4000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try { await run(page, errors); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.error(`FAIL: ${name}`, error); }
  finally { await context.close(); }
}
const profile = { ...EMPTY_PROFILE, fullName: 'Fixture Candidate', email: 'fixture@example.com', expectedSalary: '100000' };
const settings = { KEYWORDS: 'engineer', MIN_SALARY: '100000', ONSITE_CITY: 'Sydney', WORK_ARRANGEMENTS: 'remote' };
const fallback = (path: string) => path === '/api/profile' ? profile : path === '/api/settings' ? settings
  : path === '/api/resumes' ? [] : path === '/api/knowledge' ? { items: [] }
  : path === '/api/setup/status' ? { checks: [], ready: true, done: 0, total: 0 }
  : path === '/api/entitlements' ? { tier: 'standard', fineTune: false, advancedFilters: false }
  : { supported: false, session: null };
try {
  await check('failed initial settings reads can retry successfully', async (page, errors) => {
    let failed = true;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ status: failed && path === '/api/settings' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failed && path === '/api/settings' ? { error: 'Fixture settings unavailable' } : fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html?settings`);
    await page.getByRole('alert').filter({ hasText: 'Could not load your settings' }).waitFor();
    failed = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('select')).some(select => select.value === 'Sydney'));
    assert.equal(await page.getByRole('alert').count(), 0); assert.deepEqual(errors, []);
  });
  await check('a stale initial settings read cannot overwrite a completed save', async (page, errors) => {
    let stored = { ...settings }, released = false, started!: () => void;
    const held = new Promise<void>(resolve => { started = resolve; });
    const releaseReads: Array<() => void> = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/settings' && request.method() === 'POST') {
        stored = { ...stored, ...request.postDataJSON().updates };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ settings: stored }) });
      }
      const snapshot = path === '/api/settings' ? { ...stored } : fallback(path);
      if (path === '/api/settings' && !released) await new Promise<void>(resolve => { releaseReads.push(resolve); started(); });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }).catch(() => {});
    });
    await page.goto(`${origin}/settings-fixture.html?settings`); await held;
    const city = page.getByRole('combobox', { name: /My city/ });
    await city.selectOption('Melbourne'); await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(await city.inputValue(), 'Melbourne');
    const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'GET');
    released = true; releaseReads.forEach(release => release()); await staleResponse;
    await page.waitForTimeout(100);
    assert.equal(await city.inputValue(), 'Melbourne'); assert.equal(stored.ONSITE_CITY, 'Melbourne');
    assert.deepEqual(errors, []);
  });
  await check('application outcomes retain the drawer on failed saves and update only after successful retry', async (page, errors) => {
    let mode = 'server-error', writes = 0;
    await page.route('**/api/**', route => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        writes++;
        if (mode === 'network') return route.abort();
        if (mode === 'server-error') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture outcome unavailable"}' });
        if (mode === 'html') return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Unavailable</h1>' });
        if (mode === 'malformed') return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ applications: [{ ...application, outcome: request.postDataJSON().patch.outcome }] }) });
      }
      return route.fulfill({ contentType: 'application/json', body: '[]' });
    });
    await page.goto(`${origin}/settings-fixture.html?applications`);
    await page.locator('tr.application-item').first().click();
    const interview = page.locator('.drawer').getByRole('button', { name: 'Interview', exact: true });
    await interview.click(); await page.getByRole('alert').filter({ hasText: 'Fixture outcome unavailable' }).waitFor();
    for (const failure of ['network', 'html', 'malformed']) {
      mode = failure; await interview.click();
      await page.getByRole('alert').waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.drawer .chips button')?.disabled);
      assert.equal(await page.locator('.drawer').count(), 1);
    }
    mode = 'success'; await interview.click();
    await page.locator('.drawer').waitFor({ state: 'detached' });
    assert.ok(await page.locator('tr.application-item').first().getByText('Interview', { exact: true }).isVisible());
    assert.equal(writes, 5); assert.deepEqual(errors, []);
  });
  await check('a rejected setup status request cannot crash the settings screen', async (page, errors) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ status: path === '/api/setup/status' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(path === '/api/setup/status' ? { error: 'Fixture status unavailable' } : fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html?settings`);
    await page.getByRole('spinbutton', { name: /Minimum annual salary/ }).fill('150000');
    await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });
  await check('profile load failures expose retry and recover without rendering error JSON as a profile', async (page, errors) => {
    let failed = true;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failed ? { error: 'Fixture profile unavailable' } : fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html`);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Full name', { exact: true }).count(), 0);
    failed = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.equal(await page.getByLabel('Full name', { exact: true }).inputValue(), 'Fixture Candidate');
    assert.deepEqual(errors, []);
  });
  await check('profile save preserves edits typed while a previous version saves', async (page, errors) => {
    let release!: () => void, started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/api/**', async route => {
      if (route.request().method() === 'PATCH') {
        const submitted = route.request().postDataJSON();
        await new Promise<void>(resolve => { release = resolve; started(); });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profile: submitted }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(profile) });
    });
    await page.goto(`${origin}/settings-fixture.html`);
    const name = page.getByLabel('Full name', { exact: true });
    await name.fill('First submitted name'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await requested; await name.fill('New unsaved name'); release();
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.profile-save button')?.textContent?.trim() === 'Save');
    assert.equal(await name.inputValue(), 'New unsaved name');
    assert.equal(await page.getByText('Unsaved changes', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  });
  await check('settings network and non-JSON failures keep changes retryable without unhandled errors', async (page, errors) => {
    let mode = 'network';
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/settings' && request.method() === 'POST') {
        if (mode === 'network') return route.abort();
        if (mode === 'html') return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Unavailable</h1>' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ settings: { ...settings, ...request.postDataJSON().updates } }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html?settings`);
    const salary = page.getByRole('spinbutton', { name: /Minimum annual salary/ });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="number"][step="5000"]')?.value === '100000');
    await salary.fill('150000'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.equal(await salary.inputValue(), '150000');
    mode = 'html'; await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.equal(await salary.inputValue(), '150000');
    mode = 'success'; await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0); assert.deepEqual(errors, []);
  });
  await check('rapid automatic settings saves run in order and retain the latest city', async (page, errors) => {
    let release!: () => void, started!: () => void, writes = 0;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let stored = { ...settings };
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/settings' && request.method() === 'POST') {
        writes++;
        if (writes === 1) await new Promise<void>(resolve => { release = resolve; started(); });
        stored = { ...stored, ...request.postDataJSON().updates };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ settings: stored }) });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path === '/api/settings' ? stored : fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html?settings`);
    const city = page.getByRole('combobox', { name: /My city/ });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('select')).some(select => select.value === 'Sydney'));
    await city.selectOption('Melbourne'); await requested; await city.selectOption('Brisbane');
    await page.waitForTimeout(150);
    const beforeRelease = writes; release();
    await page.waitForFunction(() => !document.querySelector('.save-bar'));
    assert.equal(beforeRelease, 1, 'the second save waits for the first');
    assert.equal(await city.inputValue(), 'Brisbane'); assert.equal(stored.ONSITE_CITY, 'Brisbane'); assert.equal(writes, 2);
    assert.deepEqual(errors, []);
  });
  await check('resume upload refresh preserves unrelated unsaved settings', async (page, errors) => {
    let refreshes = 0;
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/settings') refreshes++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(request.method() === 'POST' ? { ok: true, autofilled: [] } : fallback(path)) });
    });
    await page.goto(`${origin}/settings-fixture.html?settings`);
    const salary = page.getByRole('spinbutton', { name: /Minimum annual salary/ });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="number"][step="5000"]')?.value === '100000');
    await salary.fill('150000');
    await page.getByText('Upload your resume', { exact: true }).first().click();
    const before = refreshes;
    await page.locator('input[type=file]').first().setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture resume for local regression only') });
    await page.waitForFunction(() => !document.querySelector('.files-grid .banner'));
    await page.waitForTimeout(250);
    assert.ok(refreshes > before, 'upload caused settings refresh');
    if (!await salary.isVisible()) await page.getByText("What you're after", { exact: true }).click();
    assert.equal(await salary.inputValue(), '150000');
    assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  });
} finally { await browser.close(); await server.close(); }
if (failures) process.exitCode = 1;
