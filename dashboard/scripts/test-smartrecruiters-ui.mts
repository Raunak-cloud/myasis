import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Serve only the built frontend and fixture APIs: no database, worker or employer is contacted.
const dist = resolve(import.meta.dirname, '../dist');
let admin = true;
let searchStarted = false;
const writes: Array<{ path: string; body: any }> = [];
const settings = () => ({ PLATFORMS: admin ? 'smartrecruiters' : 'seek', SMARTRECRUITERS_COMPANIES: 'Canva,KPMGAustralia1,Colliers',
  KEYWORDS: 'software engineer', WORK_ARRANGEMENTS: 'remote,hybrid,onsite', ONSITE_CITY: 'Sydney',
  MIN_SALARY: '70000', MIN_SCORE: '60', MAX_AGE_DAYS: '14', MAX_APPS_PER_RUN: '5', MAX_APPS_PER_DAY: '20', MAX_EVALUATIONS: '40', PAGES_PER_KEYWORD: '1' });
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') writes.push({ path, body: JSON.parse(body || '{}') });
    if (path === '/api/run' && req.method === 'POST' && JSON.parse(body || '{}').mode === 'search') searchStarted = true;
    const payloads: Record<string, unknown> = {
      '/api/auth/me': { user: { id: 'fixture', email: 'fixture@example.test', name: 'Fixture Candidate' }, googleConfigured: true },
      '/api/entitlements': { tier: admin ? 'admin' : 'standard', manualRuns: admin, firstRunRequired: !admin,
        autoRunsPerDay: 1, autoApplyPaused: true, canPauseAutoApply: true, autoRunsUsedToday: 0,
        scheduledMinScore: null, scheduledJobsPerDay: null, evaluationsPerRun: null, maxApplicationsPerRunOverride: null,
        fineTune: admin, advancedFilters: admin, indeedApplications: admin, runScopes: admin, humanizer: admin },
      '/api/billing/status': { configured: true, totalRemaining: 5, free: { allowance: 5, used: 0, remaining: 5 },
        paid: { remaining: 0, employerSiteRemaining: 0, expiresAt: null, hasActivePass: false } },
      '/api/signin/session': { supported: false, session: null, seek: { signedIn: !admin }, indeed: { signedIn: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: searchStarted, mode: searchStarted ? 'search' : null, startedAt: searchStarted ? new Date().toISOString() : null, finishedAt: null, applied: 0, isOwner: true },
      '/api/run/last': { startedAt: null }, '/api/run/stream': null, '/api/autorun': null,
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 }, '/api/applications': [], '/api/attention': [],
      '/api/board-resumes': { boards: [] }, '/api/gmail/status': { connected: false },
      '/api/settings': req.method === 'POST' ? { ok: true, settings: settings() } : settings(),
      '/api/run': { ok: true, mode: 'live' },
    };
    if (path === '/api/run/stream') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payloads[path] ?? {}));
    return;
  }
  const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  for (admin of [true, false]) {
    searchStarted = false;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/?tab=run`);
    await page.getByRole('button', { name: admin ? 'Start auto apply' : 'Start first run', exact: true }).click({ timeout: 15_000 });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    if (admin) {
      const browserChoice = dialog.getByRole('combobox', { name: 'Employer browser', exact: true });
      assert.equal(await browserChoice.inputValue(), 'local');
      await browserChoice.selectOption('brightdata');
      assert.match(await dialog.textContent() ?? '', /Bright Data receives your resume/);
      await dialog.locator('button.chip').filter({ hasText: 'SmartRecruiters' }).waitFor();
      assert.equal(await dialog.locator('[data-field=SMARTRECRUITERS_COMPANIES] input').inputValue(), 'Canva,KPMGAustralia1,Colliers');
      assert.match(await dialog.textContent() ?? '', /no job-board sign-in required/i);
      for (const source of EMPLOYER_SOURCES.filter(source => source.id !== 'smartrecruiters')) {
        await dialog.locator('button.chip').filter({ hasText: source.label }).click();
        assert.equal(await dialog.locator(`[data-field=${source.key}] input`).inputValue(), source.defaults);
        await dialog.locator('button.chip').filter({ hasText: source.label }).click();
      }
    } else {
      assert.equal(await dialog.getByRole('combobox', { name: 'Employer browser', exact: true }).count(), 0);
      assert.equal(await dialog.locator('button.chip').filter({ hasText: 'SmartRecruiters' }).count(), 0);
      assert.equal(await dialog.locator('[data-field=SMARTRECRUITERS_COMPANIES]').count(), 0);
      for (const source of EMPLOYER_SOURCES) {
        assert.equal(await dialog.locator('button.chip').filter({ hasText: source.label }).count(), 0);
        assert.equal(await dialog.locator(`[data-field=${source.key}]`).count(), 0);
      }
      assert.equal(await dialog.getByRole('button', { name: 'Test without applying', exact: true }).count(), 0);
    }
    await dialog.getByRole('button', { name: admin ? 'Save and apply' : 'Start first run', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const submitted = writes.filter(write => write.path === '/api/run').at(-1)!.body;
    assert.equal(submitted.overrides.PLATFORMS, admin ? 'smartrecruiters' : 'seek');
    assert.equal('SMARTRECRUITERS_COMPANIES' in submitted.overrides, admin);
    assert.equal('EMPLOYER_BROWSER_PROVIDER' in submitted.overrides, admin);
    if (admin) assert.equal(submitted.overrides.EMPLOYER_BROWSER_PROVIDER, 'brightdata');
    for (const source of EMPLOYER_SOURCES) assert.equal(source.key in submitted.overrides, admin);
    assert.equal(submitted.mode, 'live');
    assert.equal(submitted.confirm, true);
    if (admin) {
      const settingsWrites = writes.filter(write => write.path === '/api/settings').length;
      await page.getByRole('button', { name: 'Start auto apply', exact: true }).click();
      await dialog.waitFor();
      await dialog.getByLabel('SmartRecruiters employer identifiers').fill('ALDIStores,MedHealth3');
      for (const source of EMPLOYER_SOURCES.filter(source => source.id !== 'smartrecruiters')) await dialog.locator('button.chip').filter({ hasText: source.label }).click();
      await dialog.getByRole('button', { name: 'Test without applying', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const testRun = writes.filter(write => write.path === '/api/run').at(-1)!.body;
      assert.equal(testRun.mode, 'search');
      assert.equal('confirm' in testRun, false);
      assert.equal(testRun.scope, 'external');
      assert.equal(testRun.overrides.PLATFORMS, EMPLOYER_SOURCES.map(source => source.id).join(','));
      assert.equal(testRun.overrides.SMARTRECRUITERS_COMPANIES, 'ALDIStores,MedHealth3');
      for (const source of EMPLOYER_SOURCES.filter(source => source.id !== 'smartrecruiters')) assert.equal(testRun.overrides[source.key], source.defaults);
      assert.equal(testRun.overrides.MAX_EVALUATIONS, '10');
      assert.equal(testRun.overrides.PAGES_PER_KEYWORD, '1');
      assert.equal(writes.filter(write => write.path === '/api/settings').length, settingsWrites, 'test drafts must not be saved');
      await page.getByText('Search-only test. No application forms are opened or applications submitted.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Search test', { exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'View live action', exact: true }).count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: admin-only SmartRecruiters live and bounded search-only test controls; tests do not save drafts or request live submissions; customer requests omit pilot settings; fixture APIs only');
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
