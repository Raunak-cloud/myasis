import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
import { PLAN_LIMITS } from '../src/pricing.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
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
let preparedFixture = false;
let approvedFixture = false;
let preparingFixture = false;
const approvedIds = new Set<string>();
const e2eDrafts = process.env.SEMI_AUTO_E2E_REPORT ? JSON.parse(readFileSync(process.env.SEMI_AUTO_E2E_REPORT, 'utf8')).prepared : null;
const preparedRows = () => e2eDrafts ? e2eDrafts.map((application: any) => ({ id: application.id, application, status: approvedIds.has(application.id) ? 'approved' : 'ready', detail: null })) : [1, 2].map(index => ({ id: `00000000-0000-4000-8000-00000000000${index}`, status: approvedFixture && index === 1 ? 'approved' : 'ready', detail: null,
  application: { revision: String(index).repeat(64), job: { title: `Prepared Role ${index}`, company: 'Fixture Employer', location: 'Sydney', url: `https://fixture.invalid/job/${index}` },
    resume: 'Fixture CV.pdf', coverLetter: 'Dear employer,\n\nFixture application letter.', answers: [{ question: 'Availability', answer: 'Two weeks' }] } }));
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
    if (path === '/api/application-reviews/submit' && req.method === 'POST') {
      approvedFixture = true;
      for (const item of JSON.parse(body).applications) approvedIds.add(item.id);
    }
    if (path === '/api/run' && req.method === 'POST' && JSON.parse(body || '{}').mode === 'search') searchStarted = true;
    const payloads: Record<string, unknown> = {
      '/api/auth/me': { user: { id: 'fixture', email: 'fixture@example.test', name: 'Fixture Candidate' }, googleConfigured: true },
      '/api/entitlements': { tier: admin ? 'admin' : 'standard', manualRuns: true, firstRunRequired: !admin,
        autoRunsPerDay: 1, autoApplyPaused: true, canPauseAutoApply: false, autoRunsUsedToday: 0,
        scheduledMinScore: null, scheduledJobsPerDay: admin ? null : PLAN_LIMITS.free.evaluationsPerRun,
        evaluationsPerRun: admin ? null : PLAN_LIMITS.free.evaluationsPerRun, maxApplicationsPerRunOverride: null,
        fineTune: admin, advancedFilters: admin, indeedApplications: admin, runScopes: admin },
      '/api/billing/status': { configured: true, totalRemaining: 5, free: { allowance: 5, used: 0, remaining: 5 },
        paid: { remaining: 0, employerSiteRemaining: 0, expiresAt: null, hasActivePass: false } },
      '/api/signin/session': { supported: false, session: null, seek: { signedIn: !admin || adminSeekSignedIn }, indeed: { signedIn: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: searchStarted || preparingFixture, mode: searchStarted ? 'search' : preparingFixture ? 'live' : null, applicationMode: preparingFixture ? 'semi-auto' : null, prepared: 0, startedAt: searchStarted || preparingFixture ? new Date().toISOString() : null, finishedAt: null, applied: 0, isOwner: true },
      '/api/run/last': { startedAt: null }, '/api/run/stream': null, '/api/autorun': null,
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 }, '/api/applications': [],
      '/api/attention': attentionFixture ? [{ jobId: 'handoff-fixture', title: 'Fixture Developer', company: 'Fixture Employer', kind: 'question', reason: 'Your answer is needed', at: new Date().toISOString(), url: 'https://fixture.invalid', questions: [{ question: 'Country of birth', kind: 'select', options: ['Australia', 'Canada'] }, { question: 'Audit services', kind: 'select', options: ['Unrelated skill'] }] }] : [],
      '/api/answers': { saved: 2 },
      '/api/skipped': { items: skippedFixture ? [{ jobId: 'skip-fixture', title: 'Skipped Fixture Role', company: 'Fixture Employer', kind: 'fit', reason: 'Experience does not match', url: '', at: new Date().toISOString(), verdict: null, note: null }] : [] },
      '/api/board-resumes': { boards: [] }, '/api/gmail/status': { connected: false },
      '/api/settings': req.method === 'POST' ? { ok: true, settings: settings() } : settings(),
      '/api/run': { ok: true, mode: 'live' },
      '/api/application-reviews': { applications: preparedFixture ? preparedRows() : [] },
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
    await page.route('**/api/resumes', route => route.fulfill({contentType:'application/json',body:JSON.stringify([{id:'fixture-resume',label:'Fixture resume'}])}));
    await page.route('**/api/search-terms/generate', route => route.fulfill({contentType:'application/json',body:JSON.stringify({terms:['AI Engineer','Web Developer','Python Developer','Frontend Developer'],resumeLabel:'Fixture resume'})}));
    await page.goto(`${origin}/?tab=run`);
    await page.getByRole('button', { name: 'Start Auto apply', exact: true }).waitFor();
    const searchCard = page.locator('.saved-search-card');
    await searchCard.locator('#saved-search-terms').fill('Web Developer,Python Developer');
    await searchCard.locator('#saved-search-terms').press('Enter');
    assert.equal(await searchCard.locator('.terms-chip').count(),3);
    await searchCard.locator('#saved-search-terms').fill('Fourth Developer');
    await searchCard.getByRole('alert').filter({hasText:'at most 3'}).waitFor();
    assert.equal(await searchCard.locator('.terms-chip').count(),3,'manual edits cannot add a fourth title');
    await searchCard.getByRole('button',{name:'✨ Suggest from my resumes',exact:true}).click();
    await searchCard.getByText('Suggested 3 job titles from Fixture resume. Review them, then save.',{exact:true}).waitFor();
    assert.equal(await searchCard.locator('.terms-chip').count(),3,'even an oversized API response cannot insert four suggestions');
    assert.equal(await searchCard.getByRole('button',{name:'Remove Frontend Developer',exact:true}).count(),0);
    assert.equal(await page.getByRole('combobox', { name: 'Saved application model', exact: true }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Saved application decisions', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Start Auto apply', exact: true }).click({ timeout: 15_000 });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: 'Application decisions', exact: true }).count(), 0);
    if (admin) {
      assert.equal(await dialog.getByRole('combobox', { name: 'Application model', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('combobox', { name: 'Employer browser', exact: true }).count(), 0, 'account choices cannot bypass server browser routing');
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
      await dialog.getByText('AI reviews up to 15 jobs this run. Only successful applications use your application allowance.', { exact: true }).waitFor();
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
    await dialog.getByRole('button', { name: 'Start Auto apply', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const submitted = writes.filter(write => write.path === '/api/run').at(-1)!.body;
    assert.equal(submitted.overrides.PLATFORMS, admin ? 'smartrecruiters' : 'seek');
    assert.equal('SMARTRECRUITERS_COMPANIES' in submitted.overrides, admin);
    assert.equal('EMPLOYER_BROWSER_PROVIDER' in submitted.overrides, false);
    assert.equal('APPLICATION_AI_MODEL' in submitted.overrides, admin);
    if (admin) assert.equal(submitted.overrides.APPLICATION_AI_MODEL, 'celeris');
    for (const source of EMPLOYER_SOURCES) assert.equal(source.key in submitted.overrides, admin);
    assert.equal(submitted.mode, 'live');
    assert.equal(submitted.confirm, true);
    if (admin) {
      const settingsWrites = writes.filter(write => write.path === '/api/settings').length;
      await page.getByRole('button', { name: 'Start Auto apply', exact: true }).click();
      await dialog.waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: 'Application decisions', exact: true }).count(), 0);
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
      await page.getByRole('button', { name: 'Start Auto apply', exact: true }).click();
      await dialog.waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: 'Application decisions', exact: true }).count(), 0);
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
  admin = false; preparedFixture = true; searchStarted = false;
  for (const width of [1280, 390]) {
    approvedFixture = false;
    approvedIds.clear();
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const before = writes.filter(write => write.path === '/api/run').length;
    await page.goto(`${origin}/?tab=run`);
    await page.getByRole('button', { name: 'Start Auto apply', exact: true }).waitFor();
    assert.equal(writes.filter(write => write.path === '/api/run').length, before, 'complete setup never starts a run');
    assert.equal(await page.getByRole('region', { name: 'Prepared applications', exact: true }).count(), 0, 'prepared applications have their own page');
    assert.equal(await page.getByRole('switch', { name: 'Automatic runs', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Semi auto', exact: true }).click();
    await page.getByRole('button', { name: 'Start Semi auto', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('This run fills applications and saves them for your review. Owtomate submits only the jobs you later confirm from the prepared list.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Start Semi auto', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.filter(write => write.path === '/api/run').at(-1)!.body.applicationMode, 'semi-auto');
    assert.equal(await page.locator('.prepared-applications').count(), 0);
    if (width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    assert.equal(await navigation.getByRole('button', { name: 'Applications', exact: true }).count(), 0);
    await navigation.getByRole('button', { name: /^Submitted Applications/ }).click();
    await page.getByRole('heading', { name: 'Submitted Applications', exact: true }).waitFor();
    if (width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await navigation.getByRole('button', { name: 'Prepared Applications', exact: true }).click();
    await page.getByRole('heading', { name: 'Prepared Applications', exact: true }).waitFor();
    await page.getByLabel('Select Prepared Role 1 at Fixture Employer', { exact: true }).check();
    const card = page.locator('.prepared-application').first();
    await card.getByText('Review application', { exact: true }).click();
    await card.getByText('Two weeks', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm and apply to 1 job', exact: true }).click();
    await page.getByText('Confirmed · submission in progress', { exact: true }).waitFor();
    const approval = writes.filter(write => write.path === '/api/application-reviews/submit').at(-1)!.body;
    assert.deepEqual(approval, { confirm: true, applications: [{ id: preparedRows()[0].id, revision: preparedRows()[0].application.revision }] });
    assert.equal(await page.getByLabel('Select Prepared Role 2 at Fixture Employer', { exact: true }).isChecked(), false);
    if (e2eDrafts) {
      assert.equal(e2eDrafts.length, 5);
      for (let index = 2; index <= 5; index++) await page.getByLabel(`Select Prepared Role ${index} at Fixture Employer`, { exact: true }).check();
      await page.getByRole('button', { name: 'Confirm and apply to 4 jobs', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm and apply to 4 jobs', exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(writes.filter(write => write.path === '/api/application-reviews/submit').at(-1)!.body.applications,
        e2eDrafts.slice(1).map((draft: any) => ({ id: draft.id, revision: draft.revision })));
      assert.equal(await page.getByText('Confirmed · submission in progress', { exact: true }).count(), 5);
    }
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.deepEqual(errors, []);
    mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/semi-auto-${width}.png`), fullPage: true });
    await context.close();
  }
  preparedFixture = false;
  const emptyContext = await browser.newContext();
  const emptyPage = await emptyContext.newPage();
  await emptyPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await emptyPage.goto(`${origin}/?tab=prepared`);
  await emptyPage.getByRole('heading', { name: 'Prepared Applications', exact: true }).waitFor();
  await emptyPage.getByRole('link', { name: 'Apply page', exact: true }).click();
  await emptyPage.getByRole('heading', { name: 'Apply for jobs', exact: true }).waitFor();
  await emptyPage.getByRole('button', { name: 'Semi auto', exact: true }).click();
  await emptyPage.getByRole('link', { name: 'Prepared Applications', exact: true }).click();
  await emptyPage.getByRole('heading', { name: 'Prepared Applications', exact: true }).waitFor();
  await emptyContext.close();
  preparingFixture = true;
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/?tab=run`);
    if (width < 768) await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.locator('.active-mode-label').filter({ hasText: /^Preparing$/ }).waitFor();
    assert.equal(await page.locator('.active-mode-label').filter({ hasText: /^Applying$/ }).count(), 0, 'a reopened Semi auto run is Preparing');
    await page.reload();
    if (width < 768) await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.locator('.active-mode-label').filter({ hasText: /^Preparing$/ }).waitFor();
    await context.close();
  }
  preparingFixture = false;
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
