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
let adminBoards = 'smartrecruiters';
let adminSeekSignedIn = false;
let attentionFixture = false;
let skippedFixture = false;
const writes: Array<{ path: string; body: any }> = [];
const settings = () => ({
  PLATFORMS: admin ? adminBoards : 'seek', SMARTRECRUITERS_COMPANIES: 'Canva,KPMGAustralia1,Colliers',
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
      '/api/signin/session': { supported: false, session: null, seek: { signedIn: !admin || adminSeekSignedIn }, indeed: { signedIn: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: searchStarted, mode: searchStarted ? 'search' : null, startedAt: searchStarted ? new Date().toISOString() : null, finishedAt: null, applied: 0, isOwner: true },
      '/api/run/last': { startedAt: null }, '/api/run/stream': null, '/api/autorun': null,
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 }, '/api/applications': [],
      '/api/attention': attentionFixture ? [{ jobId: 'handoff-fixture', title: 'Fixture Developer', company: 'Fixture Employer', kind: 'question', reason: 'Your answer is needed', at: new Date().toISOString(), url: 'https://fixture.invalid', questions: [{ question: 'Country of birth', kind: 'select', options: ['Australia', 'Canada'] }, { question: 'Audit services', kind: 'select', options: ['Unrelated skill'] }] }] : [],
      '/api/answers': { saved: 2 },
      '/api/skipped': { items: skippedFixture ? [{ jobId: 'skip-fixture', title: 'Skipped Fixture Role', company: 'Fixture Employer', kind: 'fit', reason: 'Experience does not match', url: '', at: new Date().toISOString(), verdict: null, note: null }] : [] },
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
    await page.getByRole('button', { name: admin ? 'Start auto apply' : 'Start first run', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Saved application model', exact: true }).count(), admin ? 1 : 0);
    await page.getByRole('button', { name: admin ? 'Start auto apply' : 'Start first run', exact: true }).click({ timeout: 15_000 });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    if (admin) {
      const modelChoice = dialog.getByRole('combobox', { name: 'Application model', exact: true });
      assert.equal(await modelChoice.inputValue(), 'celeris');
      assert.deepEqual(await Promise.all((await modelChoice.locator('option').all()).map(option => option.getAttribute('value'))), ['celeris', 'haiku']);
      await modelChoice.selectOption('haiku');
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
      assert.equal(await dialog.getByRole('combobox', { name: 'Application model', exact: true }).count(), 0);
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
    assert.equal('APPLICATION_AI_MODEL' in submitted.overrides, admin);
    if (admin) assert.equal(submitted.overrides.APPLICATION_AI_MODEL, 'haiku');
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
      // The same bounded, non-submitting control must also cover job-board discovery.
      searchStarted = false;
      adminBoards = 'seek';
      adminSeekSignedIn = true;
      await page.reload();
      await page.getByRole('button', { name: 'Start auto apply', exact: true }).click();
      await dialog.waitFor();
      await dialog.locator('[data-field=MAX_EVALUATIONS]').fill('2');
      await dialog.getByRole('button', { name: 'Test without applying', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const boardRun = writes.filter(write => write.path === '/api/run').at(-1)!.body;
      assert.equal(boardRun.mode, 'search');
      assert.equal('confirm' in boardRun, false);
      assert.equal(boardRun.scope, 'all');
      assert.equal(boardRun.overrides.PLATFORMS, 'seek');
      assert.equal(boardRun.overrides.MAX_EVALUATIONS, '2');
      assert.equal(boardRun.overrides.PAGES_PER_KEYWORD, '1');
      assert.equal(writes.filter(write => write.path === '/api/settings').length, settingsWrites);
      await page.getByRole('button', { name: 'View live action', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  admin = true;
  attentionFixture = true; searchStarted = false;
  const answerContext = await browser.newContext();
  const answerPage = await answerContext.newPage();
  await answerPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await answerPage.goto(`${origin}/?tab=attention`);
  await answerPage.getByRole('button', { name: /^Enter a different answer: Country of birth$/ }).click();
  await answerPage.getByRole('textbox', { name: 'What should Owtomate enter for “Country of birth”?', exact: true }).fill('Nepal');
  await answerPage.getByRole('button', { name: /^Enter a different answer: Audit services$/ }).click();
  await answerPage.getByRole('textbox', { name: 'What should Owtomate enter for “Audit services”?', exact: true }).fill('No');
  const runsBeforeSave = writes.filter(write => write.path === '/api/run').length;
  await Promise.all([
    answerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST'),
    answerPage.getByRole('button', { name: 'Save and retry', exact: true }).click(),
  ]);
  const answerWrite = writes.filter(write => write.path === '/api/answers').at(-1)!;
  assert.deepEqual(answerWrite.body, { jobId: 'handoff-fixture', answers: [{ question: 'Country of birth', answer: 'Nepal' }, { question: 'Audit services', answer: 'No' }] });
  assert.equal(writes.filter(write => write.path === '/api/run').length, runsBeforeSave, 'saving explicit facts does not submit or start a live job');
  await answerContext.close();
  // Retention policy is visible with both populated and empty skipped history.
  const skippedContext = await browser.newContext();
  const skippedPage = await skippedContext.newPage();
  await skippedPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (skippedFixture of [false, true]) {
    await skippedPage.goto(`${origin}/?tab=applications`);
    await skippedPage.getByRole('tab', { name: /^Skipped/ }).click();
    await skippedPage.getByText('Only your latest 500 skipped-job records are stored. Older records are automatically deleted.', { exact: true }).waitFor();
    await skippedPage.getByText(skippedFixture ? 'Skipped Fixture Role' : 'Nothing skipped lately', { exact: true }).waitFor();
  }
  await skippedContext.close();
  console.log('PASS: application controls, employer feeds, search-only tests, candidate answers and skipped retention notice; fixture APIs only');
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
