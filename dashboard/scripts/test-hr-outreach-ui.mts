/** Real dashboard components, fictional APIs only. No mail, accounts or database writes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const now = new Date().toISOString();
const apps = [{ jobId: 'one', platform: 'seek', title: 'Data Analyst', company: 'Fixture Employer', location: 'Sydney', url: 'https://fixture.invalid/job', appliedAt: now, score: 90 },
  { jobId: 'one', platform: 'indeed', title: 'Different employer role', company: 'Another Employer', location: 'Sydney', url: 'https://fixture.invalid/another', appliedAt: now, score: 80 },
  { jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', location: 'Sydney', url: 'https://fixture.invalid/old', appliedAt: now, score: 85 }];
const literal = '<img src=x onerror="window.fixtureInjected=true">\nThanks for considering my application.\n' + 'Long factual candidate message. '.repeat(25);
const items = ['sent', 'queued', 'researching', 'sending', 'skipped', 'error', 'unconfirmed'].map((status, i) => ({ id: String(100 - i), jobId: i ? 'other' : 'one', platform: 'seek', title: i ? `Fixture role ${i}` : 'Data Analyst', company: 'Fixture Employer', status,
  toEmail: i ? null : 'hiring@example.test', subject: i ? null : 'My Data Analyst application', body: i ? null : literal, createdAt: now, sentAt: i ? null : now, contactName: i ? null : 'Hiring team',
  sourceUrl: i === 1 ? 'javascript:alert(1)' : i ? null : 'https://fixture.invalid/careers', reason: status === 'skipped' ? 'No public hiring contact was found.' : null, phase: null as string | null, sourceRunId: '42' }));
const olderItems = [{ ...items[0], id: '93', jobId: 'old-history', title: 'Older outreach role', subject: 'An older introduction' },
  { ...items[0], id: '1', jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', subject: 'My archived application', body: 'Exact historical email body.' }];
let enabled = false, failSave = false, failHistory = false, failSettings = false, emptyHistory = false, failOlder = false;
let progress = { active: false, phase: 'waiting' as string | null, title: null as string | null, company: null as string | null, queued: 1, sent: 0, skipped: 0, failed: 0, runId: '42' };
let runAdmin = true;
const writes: unknown[] = [];
const html = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{ApplicationsPanel}from'/src/components/ApplicationsPanel.tsx';import'/src/index.css';const mode=new URLSearchParams(location.search).get('hr');createRoot(document.getElementById('root')).render(React.createElement(ApplicationsPanel,{apps:${JSON.stringify(apps)},onChange:()=>{},followUpDays:10,...(mode==='default'?{}:{showHrOutreach:mode!=='off'})}));</script></body></html>`;
const liveHtml = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{RunPanel}from'/src/components/RunPanel.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(RunPanel,{lastRunAt:null,onFinished:()=>{},onGoPricing:()=>{}}));</script></body></html>`;
const vite = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react(), { name: 'hr-outreach-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] === '/hr-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html)); return; }
    if (req.url?.split('?')[0] === '/hr-live-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, liveHtml)); return; }
    if (!req.url?.startsWith('/api/')) return next();
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://fixture.test');
    if (url.pathname === '/api/entitlements') { res.end(JSON.stringify({ tier: runAdmin ? 'admin' : 'standard', manualRuns: runAdmin, autoRunsPerDay: 0, canPauseAutoApply: false, fineTune: false, advancedFilters: false, runScopes: false, employerSources: false })); return; }
    if (url.pathname === '/api/run/status') { res.end(JSON.stringify({ running: false, mode: null, applicationMode: 'auto', startedAt: null, finishedAt: null, exitCode: 0, applied: 2, prepared: 0, hasKey: true, isOwner: true })); return; }
    if (url.pathname === '/api/settings') { res.end(JSON.stringify({ PLATFORMS: 'seek' })); return; }
    if (url.pathname === '/api/hr-outreach') {
      if (url.searchParams.get('activity') === '1') { res.end(JSON.stringify({ items: [], nextCursor: null, progress })); return; }
      const failed = failHistory || (failOlder && url.searchParams.has('cursor'));
      res.statusCode = failed ? 503 : 200;
      const rows = url.searchParams.has('jobId') ? [...items, ...olderItems].filter(item => item.jobId === url.searchParams.get('jobId') && item.platform === url.searchParams.get('platform'))
        : url.searchParams.has('cursor') ? olderItems : items;
      res.end(JSON.stringify(failed ? { error: 'fixture unavailable' } : { items: emptyHistory ? [] : rows, nextCursor: emptyHistory || url.searchParams.has('cursor') || url.searchParams.has('jobId') ? null : '94', progress })); return;
    }
    if (req.url === '/api/hr-outreach/settings') {
      if (failSettings) { res.statusCode = 503; res.end(JSON.stringify({ error: 'fixture unavailable' })); return; }
      if (req.method === 'POST') {
        let body = ''; for await (const part of req) body += part;
        const value = JSON.parse(body); writes.push(value);
        if (failSave) { res.statusCode = 503; res.end(JSON.stringify({ error: 'fixture unavailable' })); return; }
        enabled = value.enabled;
      }
      res.end(JSON.stringify({ enabled })); return;
    }
    res.end(JSON.stringify([]));
  });
} }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: '/usr/bin/google-chrome-stable' }) });
const screenshotDir = resolve(import.meta.dirname, '../../output/hr-outreach-ui');
await mkdir(screenshotDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1150, height: 950 } });
  // Exercise the production 30-second refresh without making this fixture slow.
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      // Test the explicit retry separately from automatic recovery: a healthy
      // poll can correctly remove its error button before a user clicks it.
      if ([5_000, 30_000].includes(delay ?? 0) && new URLSearchParams(location.search).has('manualRetry')) return interval(() => {}, 100);
      return interval(handler, [5_000, 30_000].includes(delay ?? 0) ? 100 : delay, ...args);
    }) as typeof window.setInterval;
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/hr-preview.html');
  await page.getByRole('tab', { name: 'HR emails' }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Email hiring teams after I apply' });
  await checkbox.waitFor();
  await page.waitForFunction(() => !(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);
  assert.equal(await checkbox.isChecked(), false, 'Existing account remains opted out');
  assert.equal(await page.locator('.hr-email-list .hr-email').count(), 7);
  await page.locator('.hr-outreach-activity .badge').filter({ hasText: /^Waiting for run$/ }).waitFor();
  assert.match(await page.locator('.hr-outreach-activity').innerText(), /application run is still finishing/);
  for (const label of ['Sent', 'Queued', 'Finding contact', 'Sending email', 'Not sent', 'Could not send', 'Delivery unconfirmed']) assert.ok(await page.locator('.hr-email-list .badge').filter({ hasText: new RegExp(`^${label}$`) }).count());
  await page.getByText('View sent email', { exact: true }).click();
  assert.equal(await page.locator('.hr-email-content .letter').innerText(), literal);
  assert.equal(await page.locator('.hr-email-content img').count(), 0, 'Message HTML is escaped');
  assert.equal(await page.evaluate(() => (window as unknown as Record<string, unknown>).fixtureInjected), undefined);
  assert.equal(await page.locator('.hr-contact-source').count(), 1, 'Non-HTTP contact URL is not rendered');
  await checkbox.click();
  await page.waitForFunction(() => { const input = document.querySelector('.hr-outreach-preference input') as HTMLInputElement; return input.checked && !input.disabled; });
  assert.equal(await checkbox.isChecked(), true); assert.deepEqual(writes, [{ enabled: true }]);
  failSave = true;
  await checkbox.click();
  await page.getByRole('alert').filter({ hasText: 'Could not save' }).waitFor();
  assert.equal(await checkbox.isChecked(), true, 'Failed save retains the saved choice');
  failSave = false;
  await checkbox.click();
  await page.waitForFunction(() => !(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.checked);
  await page.screenshot({ path: resolve(screenshotDir, 'desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: /^Applied/ }).click();
  await page.locator('.application-item').filter({ hasText: 'Another Employer' }).click();
  assert.equal(await page.locator('.drawer .hr-email').count(), 0, 'Same job id on another board does not leak a message');
  await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.application-item').filter({ hasText: 'Fixture Employer' }).click();
  await page.locator('.drawer .hr-email').waitFor();
  assert.match(await page.locator('.drawer .hr-email').innerText(), /hiring@example.test/);
  await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: 'HR emails' }).click();
  await page.getByText('View sent email', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 950 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout fits viewport');
  await page.screenshot({ path: resolve(screenshotDir, 'mobile.png'), fullPage: true });
  const progressing = page.locator('.hr-email-list .hr-email').nth(1);
  items[1].status = 'researching'; items[1].phase = 'researching';
  progress = { ...progress, active: true, phase: 'researching', title: items[1].title, company: items[1].company };
  await progressing.locator('.badge').filter({ hasText: /^Finding contact$/ }).waitFor();
  await page.locator('.hr-outreach-activity .badge').filter({ hasText: /^Finding contact$/ }).waitFor();
  items[1].phase = 'writing'; progress.phase = 'writing';
  await progressing.locator('.badge').filter({ hasText: /^Writing email$/ }).waitFor();
  await page.locator('.hr-outreach-activity .badge').filter({ hasText: /^Writing email$/ }).waitFor();
  items[1].status = 'sending'; items[1].phase = 'sending'; progress.phase = 'sending';
  await progressing.locator('.badge').filter({ hasText: /^Sending email$/ }).waitFor();
  items[1].status = 'unconfirmed'; items[1].phase = 'checking'; progress.phase = 'checking';
  await progressing.locator('.badge').filter({ hasText: /^Checking delivery$/ }).waitFor();
  await page.locator('.hr-outreach-activity .badge').filter({ hasText: /^Checking delivery$/ }).waitFor();
  items[1].status = 'sent'; items[1].sentAt = now; items[1].phase = null;
  progress = { ...progress, active: false, phase: null, queued: 0, sent: 2, skipped: 1, failed: 1 };
  await progressing.locator('.badge').filter({ hasText: /^Sent$/ }).waitFor();
  await page.locator('.hr-outreach-activity .badge').filter({ hasText: /^Finished$/ }).waitFor();
  assert.match(await page.locator('.hr-outreach-activity').innerText(), /2 sent · 0 waiting · 1 not sent · 1 need attention/);
  assert.equal(await page.locator('.hr-email-content .letter').first().isVisible(), true, 'Polling preserves the expanded sent message');
  await page.getByRole('tab', { name: /^Applied/ }).click();
  await page.locator('.application-item').filter({ hasText: 'Historical Employer' }).click();
  await page.locator('.drawer .hr-email').getByText('My archived application', { exact: true }).waitFor();
  await page.locator('.drawer .hr-email').getByText('View sent email', { exact: true }).click();
  assert.match(await page.locator('.drawer .hr-email .letter').innerText(), /Exact historical email body/);
  await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: 'HR emails' }).click();
  failOlder = true; await page.getByRole('button', { name: 'Load older emails', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not load older' }).waitFor();
  assert.equal(await page.locator('.hr-email-list .hr-email').count(), 8, 'A failed older page preserves existing records');
  failOlder = false; await page.getByRole('button', { name: 'Load older emails', exact: true }).click();
  await page.getByText('Older outreach role', { exact: true }).waitFor();
  assert.equal(await page.locator('.hr-email-list .hr-email').count(), 9, 'Older pages merge without duplicating drawer-fetched messages');
  await page.waitForResponse(response => response.url() === origin + '/api/hr-outreach');
  assert.equal(await page.locator('.hr-email-list .hr-email').count(), 9, 'Polling newer emails preserves older loaded records');
  assert.equal(await page.getByRole('button', { name: 'Load older emails', exact: true }).count(), 0);
  failHistory = true; await page.goto(origin + '/hr-preview.html?manualRetry=1');
  await page.getByRole('tab', { name: 'HR emails' }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not load your HR emails' }).waitFor();
  failHistory = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.locator('.hr-email-list .hr-email').first().waitFor();
  assert.equal(await page.locator('.hr-email-list .hr-email').count(), 7);
  failHistory = true; await page.goto(origin + '/hr-preview.html');
  await page.getByRole('tab', { name: 'HR emails' }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not load your HR emails' }).waitFor();
  failHistory = false;
  await page.locator('.hr-email-list .hr-email').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0, 'A healthy poll recovers automatically without requiring a click');
  failSettings = true; await page.reload(); await page.getByRole('tab', { name: 'HR emails' }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not load your email preference' }).waitFor();
  assert.equal(await checkbox.isDisabled(), true);
  failSettings = false; await page.getByRole('button', { name: 'Reload preference', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);
  assert.equal(await checkbox.isChecked(), false);
  emptyHistory = true; await page.reload(); await page.getByRole('tab', { name: 'HR emails' }).click();
  await page.getByText('No HR emails yet', { exact: true }).waitFor();
  const livePage = await browser.newPage({ viewport: { width: 390, height: 950 } });
  await livePage.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => interval(handler, delay === 5_000 ? 100 : delay, ...args)) as typeof window.setInterval;
  });
  await livePage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  progress = { active: false, phase: 'waiting', title: null, company: null, queued: 1, sent: 0, skipped: 0, failed: 0, runId: '42' };
  await livePage.goto(origin + '/hr-live-preview.html');
  await livePage.locator('.hr-outreach-activity .badge').filter({ hasText: /^Waiting for run$/ }).waitFor();
  assert.match(await livePage.locator('.hr-outreach-activity').innerText(), /HR emails will start afterwards/);
  progress.phase = 'queued';
  await livePage.locator('.hr-outreach-activity .badge').filter({ hasText: /^Queued$/ }).waitFor();
  assert.doesNotMatch(await livePage.locator('.hr-outreach-activity').innerText(), /Finished/, 'An inactive queue is pending, not finished');
  for (const [phase, label] of [['researching', 'Finding contact'], ['writing', 'Writing email'], ['sending', 'Sending email'], ['checking', 'Checking delivery']]) {
    progress = { ...progress, active: true, phase, title: 'Data Analyst', company: 'Fixture Employer' };
    await livePage.locator('.hr-outreach-activity .badge').filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
    assert.match(await livePage.locator('.hr-outreach-activity').innerText(), /Data Analyst · Fixture Employer/);
    if (phase === 'writing') await livePage.screenshot({ path: resolve(screenshotDir, 'run-progress-mobile.png'), fullPage: true });
  }
  progress = { ...progress, active: false, phase: null, queued: 0, sent: 1, skipped: 1, failed: 0 };
  await livePage.locator('.hr-outreach-activity .badge').filter({ hasText: /^Finished$/ }).waitFor();
  assert.match(await livePage.locator('.hr-outreach-activity').innerText(), /1 sent · 0 waiting · 1 not sent · 0 need attention/);
  assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await livePage.screenshot({ path: resolve(screenshotDir, 'run-finished-mobile.png'), fullPage: true });
  let disabledLiveRequests = 0;
  livePage.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/hr-outreach')) disabledLiveRequests++; });
  runAdmin = false;
  await livePage.goto(origin + '/hr-live-preview.html?hr=off');
  await livePage.locator('.run-layout').waitFor();
  assert.equal(await livePage.locator('.hr-outreach-activity').count(), 0);
  assert.equal(disabledLiveRequests, 0, 'Disabled Run activity never reads HR APIs');
  await livePage.close();
  for (const mode of ['off', 'default']) {
    const regularPage = await browser.newPage();
    let hrRequests = 0;
    regularPage.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/hr-outreach')) hrRequests++; });
    await regularPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await regularPage.goto(origin + '/hr-preview.html?hr=' + mode);
    await regularPage.locator('.application-item').first().waitFor();
    assert.equal(await regularPage.getByRole('tab', { name: 'HR emails' }).count(), 0, `HR tab hidden when flag ${mode}`);
    await regularPage.locator('.application-item').filter({ hasText: 'Fixture Employer' }).click();
    await regularPage.locator('.drawer').getByRole('heading', { name: 'Outcome', exact: true }).waitFor();
    assert.equal(await regularPage.locator('.drawer').getByRole('heading', { name: 'HR email', exact: true }).count(), 0);
    assert.equal(await regularPage.getByRole('checkbox', { name: 'Email hiring teams after I apply' }).count(), 0);
    assert.equal(hrRequests, 0, `No HR API calls when flag ${mode}`);
    await regularPage.close();
  }
  console.log('PASS: admin HR Run/history stages and waiting/finished feedback, regular/default users make no HR requests, settings recovery, exact escaped email, historical drawer, pagination, mobile layout and retries; fictional APIs, no real emails.');
} finally { await browser.close(); await vite.close(); }
