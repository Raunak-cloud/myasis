/** Real customer React components with fictional APIs; no live account or application writes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const root = resolve(import.meta.dirname, '..'), output = resolve(root, '../output/jora-beta');
let settings: Record<string, string> = { PLATFORMS: 'seek', JORA_BETA_ENABLED: 'false', KEYWORDS: 'data analyst', MIN_SALARY: '100000', MAX_AGE_DAYS: '10', ONSITE_CITY: 'Sydney' };
const writes: Array<{ path: string; body: any }> = [];
let tier: 'standard' | 'intensive' | 'admin' = 'standard';
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{RunPanel}from'/src/components/RunPanel.tsx';import'/src/index.css';
createRoot(document.getElementById('root')).render(React.createElement(RunPanel,{lastRunAt:null,onFinished:()=>{},onGoPricing:()=>{}}));</script></body></html>`;
const server = await createServer({ configFile: false, root, plugins: [react(), { name: 'jora-beta-fixture', configureServer(app) {
  app.middlewares.use(async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(await app.transformIndexHtml('/', html)); return; }
    if (!path?.startsWith('/api/')) return next();
    if (path === '/api/run/stream') { res.statusCode = 204; res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.method !== 'GET') writes.push({ path, body: JSON.parse(body || '{}') });
    if (path === '/api/settings' && req.method === 'POST') settings = { ...settings, ...JSON.parse(body).updates };
    const payloads: Record<string, unknown> = {
      '/api/settings': req.method === 'POST' ? { ok: true, settings } : settings,
      '/api/entitlements': { tier, manualRuns: true, firstRunRequired: false, autoRunsPerDay: 1, autoApplyPaused: true, canPauseAutoApply: true,
        autoRunsUsedToday: 0, scheduledMinScore: 60, scheduledJobsPerDay: 40, evaluationsPerRun: 40, maxApplicationsPerRunOverride: null,
        fineTune: tier !== 'standard', advancedFilters: tier !== 'standard', indeedApplications: tier !== 'standard', employerSources: tier !== 'standard', runScopes: false },
      '/api/billing/status': { configured: true, totalRemaining: 5, free: { allowance: 5, used: 0, remaining: 5 }, paid: { remaining: 0, hasActivePass: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: false, hasKey: true, isOwner: true, applied: 0 },
      '/api/signin/session': { supported: true, session: null, seek: { signedIn: tier !== 'admin' }, indeed: { signedIn: false } },
      '/api/auto-schedule': { enabled: false, applicationMode: 'auto', runsUsedToday: 0, runsPerDay: 1, nextRunAt: null, timeZone: 'Australia/Sydney', waitingForSetup: false },
      '/api/board-resumes': { boards: [] }, '/api/gmail/status': { connected: false },
      '/api/application-reviews': { applications: [] }, '/api/skipped': { items: [] }, '/api/attention': [], '/api/admin/simulations': { simulations: [] },
      '/api/bonus-runs': { runs: [] },
    };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payloads[path] ?? {}));
  });
} }], server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '..')] } }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  mkdirSync(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (tier of ['standard', 'intensive'] as const) {
    settings.JORA_BETA_ENABLED = 'true'; // Even a stale setting must not expose the beta.
    settings.PLATFORMS = 'seek,jora';
    await page.goto(origin);
    await page.getByText('data analyst', { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Include Jora Beta' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Sign in to Jora (optional)' }).count(), 0);
    await page.getByRole('button', { name: 'Start Auto apply', exact: true }).click();
    const customerDialog = page.getByRole('dialog'); await customerDialog.waitFor();
    assert.equal(await customerDialog.getByRole('button', { name: /Jora/ }).count(), 0);
    assert.doesNotMatch(await customerDialog.innerText(), /Jora/);
    await page.screenshot({ path: resolve(output, `customer-${tier}.png`), fullPage: true });
  }
  tier = 'admin'; settings.JORA_BETA_ENABLED = 'false'; settings.PLATFORMS = 'seek'; writes.length = 0;
  await page.goto(origin);
  const jora = page.getByRole('checkbox', { name: 'Include Jora Beta' }); await jora.waitFor();
  assert.equal(await jora.isChecked(), false); assert.equal(writes.length, 0);
  const start = page.getByRole('button', { name: 'Start Auto apply', exact: true });
  await jora.check(); assert.equal(await start.isEnabled(), true, 'admins can select public Jora search when native boards are signed out');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Saved. Your next run will use this.').waitFor();
  const updates = writes.find(write => write.path === '/api/settings')!.body.updates;
  assert.equal(updates.JORA_BETA_ENABLED, 'true');
  assert.equal(updates.PLATFORMS, undefined); assert.equal(settings.PLATFORMS, 'seek');
  assert.equal(settings.MIN_SALARY, '100000'); assert.equal(settings.MAX_AGE_DAYS, '10');
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  await start.click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: /Jora \(Beta\)/ }).waitFor();
  assert.match(await dialog.locator('[data-field="PLATFORMS"]').innerText(), /✓ Jora \(Beta\)/);
  const signInResponse = page.waitForResponse(response => response.url().endsWith('/api/signin/session') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Sign in to Jora (optional)', exact: true }).click();
  await signInResponse;
  const signIn = writes.find(write => write.path === '/api/signin/session');
  assert.equal(signIn?.body.target, 'jora'); assert.equal(signIn?.body.manual, true);
  assert.equal(writes.some(write => ['/api/run', '/api/auto-apply'].includes(write.path)), false, 'this preview never starts a real run');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['hidden from Standard and Intensive customers', 'stale customer setting cannot expose beta', 'admin beta selection', 'preferences preserved', 'private Jora sign-in target', 'desktop/mobile layout'], output }));
} finally { await browser.close(); await server.close(); }
