import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
import { PLAN_LIMITS } from '../src/pricing.js';
import { withCoverLetter } from '../../seek-bot/src/application-review-content.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Serve only the built frontend and fixture APIs: no database, worker or employer is contacted.
const dist = resolve(import.meta.dirname, '../dist');
let admin = true;
let adminControlFixture = false, adminManualRunning = false;
let adminManualMode: 'auto' | 'semi-auto' = 'auto';
let scheduleFixture = false, scheduleEnabled = false;
let scheduleMode: 'auto' | 'semi-auto' = 'auto';
let searchStarted = false;
let adminBoards = 'smartrecruiters';
let adminSeekSignedIn = false;
let attentionFixture = false;
let skippedFixture = false;
let preparedFixture = false;
let approvedFixture = false;
let preparingFixture = false;
let remainingCredits = 5;
const approvedIds = new Set<string>();
const letterEdits = new Map<string, any>();
let letterInstructions = '';
let failedLetterFixture = false;
let screenshotsEveryTurn = 'false';
const e2eDrafts = process.env.SEMI_AUTO_E2E_REPORT ? JSON.parse(readFileSync(process.env.SEMI_AUTO_E2E_REPORT, 'utf8')).prepared : null;
const preparedRows = () => (e2eDrafts ? e2eDrafts.map((application: any) => ({ id: application.id, application, status: approvedIds.has(application.id) ? 'approved' : 'ready', detail: null })) : [1, 2].map(index => ({ id: `00000000-0000-4000-8000-00000000000${index}`, status: approvedFixture && index === 1 ? 'approved' : 'ready', detail: null,
  application: { revision: String(index).repeat(64), job: { title: `Prepared Role ${index}`, company: 'Fixture Employer', location: 'Sydney', url: `https://fixture.invalid/job/${index}` },
    resume: 'Fixture CV.pdf', coverLetter: 'Dear employer,\n\nFixture application letter.', answers: [{ question: 'Availability', answer: 'Two weeks' }] } }))).map((row: any, index: number) => ({ ...row,
      ...(failedLetterFixture && index === 0 && !approvedIds.has(row.id) ? { status: 'failed', detail: 'Fixture submission was not confirmed.' } : {}),
      application: letterEdits.get(row.id) ?? row.application }));
const writes: Array<{ path: string; body: any }> = [];
const settings = () => ({
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: screenshotsEveryTurn,
  PLATFORMS: admin ? adminBoards : 'seek', SMARTRECRUITERS_COMPANIES: 'Canva,KPMGAustralia1,Colliers',
  KEYWORDS: 'software engineer', WORK_ARRANGEMENTS: 'remote,hybrid,onsite', ONSITE_CITY: 'Sydney',
  COVER_LETTER_INSTRUCTIONS: letterInstructions,
  MIN_SALARY: '70000', MIN_SCORE: '60', MAX_AGE_DAYS: '14', MAX_APPS_PER_RUN: '5', MAX_APPS_PER_DAY: '20', MAX_EVALUATIONS: '40' });
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') writes.push({ path, body: JSON.parse(body || '{}') });
    if (path === '/api/settings' && req.method === 'POST' && JSON.parse(body || '{}').updates?.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN !== undefined) {
      assert.equal(admin, true, 'ordinary accounts never post screenshot testing');
      screenshotsEveryTurn = JSON.parse(body).updates.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN;
    }
    if (path === '/api/settings' && req.method === 'POST' && JSON.parse(body || '{}').updates?.COVER_LETTER_INSTRUCTIONS !== undefined) {
      letterInstructions = JSON.parse(body).updates.COVER_LETTER_INSTRUCTIONS.trim();
    }
    let editedLetter;
    if (path === '/api/application-reviews/cover-letter' && req.method === 'POST') {
      const request = JSON.parse(body);
      const row = preparedRows().find((row: any) => row.id === request.id)!;
      assert.equal(request.revision, row.application.revision);
      editedLetter = withCoverLetter(row.application, request.coverLetter);
      letterEdits.set(request.id, editedLetter);
    }
    if (path === '/api/application-reviews/submit' && req.method === 'POST') {
      approvedFixture = true;
      for (const item of JSON.parse(body).applications) approvedIds.add(item.id);
    }
    if (path === '/api/run' && req.method === 'POST' && JSON.parse(body || '{}').mode === 'search') searchStarted = true;
    if (adminControlFixture && path === '/api/run' && req.method === 'POST' && JSON.parse(body).mode === 'live') {
      adminManualRunning = true; adminManualMode = JSON.parse(body).applicationMode;
    }
    if (adminControlFixture && path === '/api/run/stop' && req.method === 'POST') adminManualRunning = false;
    if (scheduleFixture && path === '/api/auto-apply' && req.method === 'POST') {
      const input = JSON.parse(body); scheduleEnabled = input.enabled; if (input.enabled) scheduleMode = input.applicationMode;
    }
    const payloads: Record<string, unknown> = {
      '/api/auth/me': { user: { id: 'fixture', email: 'fixture@example.test', name: 'Fixture Candidate' }, googleConfigured: true },
      '/api/entitlements': { tier: admin ? 'admin' : scheduleFixture ? 'intensive' : 'standard', manualRuns: true, firstRunRequired: !admin,
        autoRunsPerDay: scheduleFixture ? 4 : 1, autoApplyPaused: !scheduleEnabled, canPauseAutoApply: scheduleFixture, autoRunsUsedToday: 0,
        scheduledMinScore: null, scheduledJobsPerDay: admin ? null : PLAN_LIMITS.free.evaluationsPerRun,
        evaluationsPerRun: admin ? null : PLAN_LIMITS.free.evaluationsPerRun, maxApplicationsPerRunOverride: null,
        fineTune: admin || scheduleFixture, advancedFilters: admin || scheduleFixture, indeedApplications: admin, runScopes: admin },
      '/api/billing/status': { configured: true, totalRemaining: remainingCredits, free: { allowance: 5, used: 5 - remainingCredits, remaining: remainingCredits },
        paid: { remaining: 0, employerSiteRemaining: 0, expiresAt: scheduleFixture ? '2026-12-23T00:00:00Z' : null, hasActivePass: scheduleFixture, hasActiveIntensivePass: scheduleFixture, unlimitedApplications: scheduleFixture } },
      '/api/signin/session': { supported: false, session: null, seek: { signedIn: !admin || adminSeekSignedIn }, indeed: { signedIn: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: searchStarted || preparingFixture || adminManualRunning, mode: searchStarted ? 'search' : preparingFixture || adminManualRunning ? 'live' : null, applicationMode: adminManualRunning ? adminManualMode : preparingFixture ? 'semi-auto' : null, prepared: 0, startedAt: searchStarted || preparingFixture || adminManualRunning ? new Date().toISOString() : null, finishedAt: null, applied: 0, isOwner: true },
      '/api/run/last': { startedAt: null }, '/api/run/stream': null, '/api/autorun': null,
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 }, '/api/applications': [],
      '/api/attention': attentionFixture ? [{ jobId: 'handoff-fixture', title: 'Fixture Developer', company: 'Fixture Employer', kind: 'question', reason: 'Your answer is needed', at: new Date().toISOString(), url: 'https://fixture.invalid', questions: [{ question: 'Country of birth', kind: 'select', options: ['Australia', 'Canada'] }, { question: 'Audit services', kind: 'select', options: ['Unrelated skill'] }] }] : [],
      '/api/answers': { saved: 2 },
      '/api/skipped': { items: skippedFixture ? [{ jobId: 'skip-fixture', title: 'Skipped Fixture Role', company: 'Fixture Employer', kind: 'fit', reason: 'Experience does not match', url: '', at: new Date().toISOString(), verdict: null, note: null }] : [] },
      '/api/board-resumes': { boards: [] }, '/api/gmail/status': { connected: false },
      '/api/settings': req.method === 'POST' ? { ok: true, settings: settings() } : settings(),
      '/api/run': { ok: true, mode: 'live' },
      '/api/auto-schedule': scheduleFixture ? { enabled: scheduleEnabled, applicationMode: scheduleMode, runsUsedToday: adminControlFixture ? 4 : 0, runsPerDay: 4, nextRunAt: scheduleEnabled ? new Date(Date.now() + (adminControlFixture ? 6 * 60 * 60_000 : 0)).toISOString() : null, dueNow: scheduleEnabled && !adminControlFixture, timeZone: 'Australia/Sydney', lastError: null } : null,
      '/api/application-reviews': { applications: preparedFixture ? preparedRows() : [] },
      '/api/application-reviews/cover-letter': { ok: true, application: editedLetter },
    };
    payloads['/api/auto-apply'] = { ok: true, entitlements: payloads['/api/entitlements'] };
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
const liveSockets = new WebSocketServer({ server, path: '/ws/screencast' });
liveSockets.on('connection', socket => socket.send(JSON.stringify({ type: 'activity', activity: { phase: 'applying', detail: 'Preparing a fixture application.' } })));
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
    assert.equal(await page.getByRole('switch', { name: 'Admin mode', exact: true }).count(), admin ? 1 : 0);
    const screenshotSwitch = page.getByRole('switch', { name: 'Screenshots each step', exact: true });
    assert.equal(await screenshotSwitch.count(), admin ? 1 : 0);
    if (admin) {
      assert.equal(await screenshotSwitch.getAttribute('aria-checked'), 'false');
      await screenshotSwitch.click();
      await page.waitForFunction(() => document.querySelector('[aria-labelledby="screenshot-each-step-label"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(screenshotsEveryTurn, 'true');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[aria-labelledby="screenshot-each-step-label"]')?.getAttribute('aria-checked') === 'true');
      mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
      await page.locator('section[aria-labelledby="screenshot-test-title"]').screenshot({ path: resolve(import.meta.dirname, '../../output/admin-screenshot-test.png') });
      await screenshotSwitch.click();
      await page.waitForFunction(() => document.querySelector('[aria-labelledby="screenshot-each-step-label"]')?.getAttribute('aria-checked') === 'false');
      assert.equal(screenshotsEveryTurn, 'false');
    }
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
    assert.equal(await dialog.locator('[data-field="MAX_APPS_PER_RUN"]').count(), 0, 'runs use the daily allowance without a per-run application control');
    assert.equal(await dialog.getByRole('combobox', { name: 'Application decisions', exact: true }).count(), 0);
    if (admin) {
      assert.equal(await dialog.getByRole('combobox', { name: 'Application model', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('combobox', { name: 'Employer browser', exact: true }).count(), 0, 'employer forms use the native browser');
      await dialog.locator('button.chip').filter({ hasText: 'SmartRecruiters' }).waitFor();
      assert.equal(await dialog.locator('[data-field=SMARTRECRUITERS_COMPANIES] input').inputValue(), 'Canva,KPMGAustralia1,Colliers');
      assert.match(await dialog.textContent() ?? '', /no job-board sign-in required/i);
      for (const source of EMPLOYER_SOURCES.filter(source => source.id !== 'smartrecruiters')) {
        await dialog.locator('button.chip').filter({ hasText: source.label }).click();
        assert.equal(await dialog.locator(`[data-field=${source.key}] input`).inputValue(), source.defaults);
        await dialog.locator('button.chip').filter({ hasText: source.label }).click();
      }
    } else {
      await dialog.getByText('AI reviews up to 15 jobs each run. Each submitted application uses one credit.', { exact: true }).waitFor();
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
      assert.equal(testRun.overrides.PAGES_PER_KEYWORD, undefined);
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
      assert.equal(boardRun.overrides.PAGES_PER_KEYWORD, undefined);
      assert.equal(writes.filter(write => write.path === '/api/settings').length, settingsWrites);
      await page.getByRole('button', { name: 'View live action', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  admin = false; preparedFixture = true; searchStarted = false;
  for (const width of [1280, 390]) {
    remainingCredits = 5;
    letterEdits.clear(); letterInstructions = '';
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
    await dialog.getByText('AI reviews up to 15 jobs each run. Each prepared application uses one credit. Confirming it uses no additional credit.', { exact: true }).waitFor();
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
    const preparedLink = navigation.getByRole('button', { name: /^Prepared Applications/ });
    const preparedBadge = page.locator('.side-link').filter({ hasText: 'Prepared Applications' }).locator('.nav-count');
    await preparedLink.click();
    await page.getByRole('heading', { name: 'Prepared Applications', exact: true }).waitFor();
    remainingCredits = 0;
    await page.goto(`${origin}/?tab=prepared`);
    await page.getByRole('heading', { name: 'Prepared Applications', exact: true }).waitFor();
    assert.equal(await page.locator('.prepared-actions').count(), 0, 'actions appear only after selecting an application');
    await page.locator('.prepared-letter-preferences > summary').click();
    const instructionInput = page.getByLabel('Instructions for all future cover letters', { exact: true });
    await instructionInput.fill(Array.from({ length: 51 }, () => 'word').join(' '));
    assert.equal(await page.getByRole('button', { name: 'Save instructions', exact: true }).isDisabled(), true);
    assert.equal(await instructionInput.getAttribute('aria-invalid'), 'true');
    const instructions = 'Use short paragraphs. Focus on relevant experience. Keep the tone direct.';
    await instructionInput.fill(instructions);
    await page.getByRole('button', { name: 'Save instructions', exact: true }).click();
    await page.getByText('Instructions saved for future cover letters.', { exact: true }).waitFor();
    await page.reload();
    await page.locator('.prepared-letter-preferences > summary').click();
    await instructionInput.waitFor();
    assert.equal(await instructionInput.inputValue(), instructions, 'cover letter preferences survive a reload');
    await page.getByLabel('Select Prepared Role 1 at Fixture Employer', { exact: true }).check();
    assert.equal(await preparedBadge.textContent(), String(preparedRows().length), 'navigation counts applications ready for review');
    const card = page.locator('.prepared-application').first();
    assert.equal(await card.locator('.prepared-content').isVisible(), false, 'documents and answers stay inside the review disclosure');
    await card.getByText('Review application', { exact: true }).click();
    await card.getByText('Two weeks', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Edit cover letter', exact: true }).click();
    const letterInput = card.getByRole('textbox', { name: 'Cover letter for Prepared Role 1 at Fixture Employer', exact: true });
    await letterInput.fill('Dear team,\n\nMy edited letter — use this exact wording.\n\nFixture Applicant');
    assert.equal(await page.locator('.prepared-actions').count(), 0, 'unsaved edits cannot be submitted');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'the cover letter editor fits the viewport');
    await letterInput.scrollIntoViewIfNeeded();
    mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/cover-letter-editor-${width}.png`) });
    await card.getByRole('button', { name: 'Save cover letter', exact: true }).click();
    await letterInput.waitFor({ state: 'hidden' });
    await card.getByText('Dear team,\n\nMy edited letter, use this exact wording.\n\nFixture Applicant', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Select Prepared Role 1 at Fixture Employer', { exact: true }).isChecked(), false, 'an edited letter requires a fresh selection');
    await card.getByText('Two weeks', { exact: true }).waitFor();
    await page.getByLabel('Select Prepared Role 1 at Fixture Employer', { exact: true }).check();
    await page.getByRole('button', { name: 'Apply to 1 job', exact: true }).click();
    await page.getByText('Waiting to submit', { exact: true }).waitFor();
    assert.equal(await preparedBadge.textContent(), String(preparedRows().length - 1), 'confirming an application reduces the prepared count');
    const approval = writes.filter(write => write.path === '/api/application-reviews/submit').at(-1)!.body;
    assert.deepEqual(approval, { confirm: true, applications: [{ id: preparedRows()[0].id, revision: preparedRows()[0].application.revision }] });
    assert.equal(await page.getByLabel('Select Prepared Role 2 at Fixture Employer', { exact: true }).isChecked(), false);
    if (e2eDrafts) {
      assert.equal(e2eDrafts.length, 5);
      for (let index = 2; index <= 5; index++) await page.getByLabel(`Select Prepared Role ${index} at Fixture Employer`, { exact: true }).check();
      await page.getByRole('button', { name: 'Apply to 4 jobs', exact: true }).click();
      await page.getByRole('button', { name: 'Apply to 4 jobs', exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(writes.filter(write => write.path === '/api/application-reviews/submit').at(-1)!.body.applications,
        e2eDrafts.slice(1).map((draft: any) => ({ id: draft.id, revision: draft.revision })));
      await page.getByText('Waiting to submit', { exact: true }).nth(4).waitFor();
      assert.equal(await page.getByText('Waiting to submit', { exact: true }).count(), 5);
    }
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.deepEqual(errors, []);
    mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/semi-auto-${width}.png`), fullPage: true });
    await context.close();
  }
  remainingCredits = 0;
  failedLetterFixture = true; approvedFixture = false; approvedIds.clear(); letterEdits.clear();
  const failedContext = await browser.newContext();
  const failedPage = await failedContext.newPage();
  await failedPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await failedPage.goto(`${origin}/?tab=prepared`);
  const failedCard = failedPage.locator('.prepared-application').first();
  await failedCard.getByText('Review application', { exact: true }).click();
  assert.equal(await failedCard.getByRole('checkbox').isDisabled(), true);
  const beforeRetry = writes.filter(write => write.path === '/api/application-reviews/submit').length;
  assert.equal(await failedCard.getByRole('button', { name: 'Retry application', exact: true }).isEnabled(), true, 'a prepaid failure can retry at zero balance');
  mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
  await failedPage.screenshot({ path: resolve(import.meta.dirname, '../../output/prepared-retry.png') });
  await failedCard.getByRole('button', { name: 'Edit cover letter', exact: true }).click();
  assert.equal(await failedCard.getByRole('button', { name: 'Retry application', exact: true }).isDisabled(), true, 'unsaved edits cannot be retried');
  await failedCard.getByRole('textbox').fill('Revised failed application letter.');
  await failedCard.getByRole('button', { name: 'Save cover letter', exact: true }).click();
  await failedCard.getByRole('textbox').waitFor({ state: 'hidden' });
  await failedCard.getByText('Revised failed application letter.', { exact: true }).waitFor();
  await failedCard.getByText('Not completed', { exact: true }).waitFor();
  await failedCard.getByText('Fixture submission was not confirmed.', { exact: true }).waitFor();
  assert.equal(await failedCard.getByRole('checkbox').isDisabled(), true, 'editing a failed application cannot authorize a retry');
  assert.equal(writes.filter(write => write.path === '/api/application-reviews/submit').length, beforeRetry, 'editing alone never submits a failed application');
  const retryRow = preparedRows()[0];
  await failedCard.getByRole('button', { name: 'Retry application', exact: true }).click();
  await failedCard.getByText('Waiting to submit', { exact: true }).waitFor();
  await failedCard.getByRole('button', { name: 'Retry application', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(writes.filter(write => write.path === '/api/application-reviews/submit').at(-1)!.body,
    { confirm: true, applications: [{ id: retryRow.id, revision: retryRow.application.revision, retry: true }] }, 'retry submits only the failed row and its current edited version');
  assert.equal(writes.filter(write => write.path === '/api/application-reviews/submit').length, beforeRetry + 1);
  assert.equal(remainingCredits, 0);
  await failedContext.close(); failedLetterFixture = false;
  remainingCredits = 5;
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
    await page.getByRole('button', { name: 'View live action', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Live action', exact: true });
    await viewer.locator('.live-action-worker-status').getByText('Preparing', { exact: true }).waitFor();
    assert.equal(await viewer.getByText('Applying', { exact: true }).count(), 0);
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
    await skippedPage.getByText('Your latest 500 skipped jobs are shown here. Older decisions are remembered so unchanged jobs do not use more reviews.', { exact: true }).waitFor();
    await skippedPage.getByText(skippedFixture ? 'Skipped Fixture Role' : 'Nothing skipped lately', { exact: true }).waitFor();
  }
  await skippedContext.close();
  // The candidate activity view shows outcomes, without internal setup or duplicate limit notices.
  attentionFixture = false; searchStarted = false; preparingFixture = false;
  for (admin of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const lines = [
      'Application workers: 2 (isolated sessions)',
      '→ Applying: Fixture Developer @ Fixture Employer',
      '✅ submitted (1/1)', 'Run cap of 1 reached.',
      'Shared application allowance is reached.', '=== Run complete: 1 new application(s) ===',
    ].map((text, seq) => ({ seq, stream: 'out', text }));
    await page.route('**/api/run/stream', route => route.fulfill({ contentType: 'text/event-stream', body: lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('') }));
    await page.goto(`${origin}/?tab=run`);
    const feed = page.locator('.activity-feed');
    await feed.getByText('Applied to Fixture Developer', { exact: true }).waitFor();
    await feed.getByText('Run complete', { exact: true }).waitFor();
    assert.equal(await feed.getByText('This run reached its limit', { exact: true }).count(), 1);
    assert.doesNotMatch(await feed.innerText(), /worker|session|shared|unconfirmed|reserved/i);
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/plain-activity-${admin ? 'admin' : 'user'}.png`) });
    await context.close();
  }
  // An admin can run either flow immediately while a fully used schedule waits for its next slot.
  admin = true; adminControlFixture = true; scheduleFixture = true; scheduleEnabled = true; scheduleMode = 'auto';
  adminBoards = 'seek'; adminSeekSignedIn = true; searchStarted = false; preparingFixture = false;
  for (const width of [1280, 390]) {
    scheduleEnabled = true; scheduleMode = 'auto';
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/?tab=run`);
    await page.getByRole('button', { name: 'Pause Auto apply', exact: true }).waitFor();
    const toggle = page.getByRole('switch', { name: 'Admin mode', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByRole('button', { name: 'Semi auto', exact: true }).isDisabled(), true);
    const writesBefore = writes.length;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    await page.route('**/api/auto-schedule', async route => {
      if (hold) { hold = false; await gate; }
      await route.continue();
    });
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auto-schedule');
    await toggle.click();
    await requested;
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: 'Semi auto', exact: true }).click();
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auto-schedule');
    release(); await delivered;
    await page.getByRole('button', { name: 'Start Semi auto', exact: true }).waitFor();
    assert.equal(writes.length, writesBefore, 'changing admin mode cannot start work or modify a schedule');
    assert.equal(scheduleEnabled, true);
    const beforeRuns = writes.filter(write => write.path === '/api/run').length;
    const beforeSchedules = writes.filter(write => write.path === '/api/auto-apply').length;
    for (const mode of ['semi-auto', 'auto'] as const) {
      const label = mode === 'semi-auto' ? 'Start Semi auto' : 'Start Auto apply';
      await page.getByRole('button', { name: mode === 'semi-auto' ? 'Semi auto' : 'Auto apply', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Start a single run now. This does not add or change scheduled runs.', { exact: true }).waitFor();
      if (mode === 'semi-auto') {
        await page.route('**/api/run', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({error:'All run slots are busy. Try again shortly.'}) }), { times: 1 });
        await dialog.getByRole('button', { name: label, exact: true }).click();
        await dialog.getByText('All run slots are busy. Try again shortly.', { exact: true }).waitFor();
        assert.equal(adminManualRunning, false);
      }
      await dialog.getByRole('button', { name: label, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const submitted = writes.filter(write => write.path === '/api/run').at(-1)!.body;
      assert.equal(submitted.applicationMode, mode); assert.equal(submitted.mode, 'live'); assert.equal(submitted.confirm, true);
      assert.equal(submitted.scope, 'all'); assert.equal('enabled' in submitted, false);
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[aria-labelledby="screenshot-each-step-label"]')?.disabled === true);
      await page.getByRole('button', { name: /Stop run/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click();
      await toggle.waitFor();
      assert.equal(scheduleEnabled, true, 'stopping a one-off run keeps the existing schedule unchanged');
    }
    assert.equal(writes.filter(write => write.path === '/api/run').length, beforeRuns + 2);
    assert.equal(writes.filter(write => write.path === '/api/auto-apply').length, beforeSchedules);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/admin-run-mode-${width}.png`), fullPage: true });
    await toggle.click();
    await page.getByRole('button', { name: 'Pause Auto apply', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Semi auto', exact: true }).isDisabled(), true);
    await toggle.click();
    await page.getByRole('button', { name: 'Pause schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Pause schedule', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(scheduleEnabled, false);
    await page.getByRole('button', { name: 'Start Auto apply', exact: true }).waitFor();
    await context.close();
  }
  adminControlFixture = false; adminManualRunning = false;
  // Recurring controls and the unlimited pricing view on desktop and mobile.
  admin = false; scheduleFixture = true; preparingFixture = false; remainingCredits = 5;
  {
    scheduleEnabled = false; scheduleMode = 'auto';
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    await page.route('**/api/auto-schedule', async route => {
      if (first) { first = false; await gate; }
      await route.continue();
    });
    try {
      await page.goto(`${origin}/?tab=run`);
      await page.getByRole('button', {name:'Semi auto',exact:true}).click();
      await page.getByRole('button', {name:'Start Semi auto',exact:true}).click();
      const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auto-schedule');
      release(); await delivered;
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', {name:'Review Semi auto settings',exact:true}).waitFor();
      await dialog.getByRole('button', {name:'Start Semi auto',exact:true}).click();
      await page.getByRole('button', {name:'Pause Semi auto',exact:true}).waitFor();
      assert.equal(writes.filter(write => write.path === '/api/auto-apply').at(-1)!.body.applicationMode, 'semi-auto', 'a delayed default Auto response cannot change the mode the user reviews and authorizes');
    } finally { release(); await context.close(); }
  }
  for (const width of [1280, 390]) {
    scheduleEnabled = false; scheduleMode = 'auto';
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/?tab=run`);
    await page.getByText('Paused', { exact: true }).waitFor();
    const schedule = page.locator('.run-actions > .run-auto-row');
    await schedule.getByText('4 runs daily', { exact: true }).waitFor();
    const checkMobileSchedule = async (buttonName: string) => {
      if (width >= 901) return;
      const button = await page.getByRole('button', { name: buttonName, exact: true }).boundingBox();
      const row = await schedule.boundingBox();
      const bar = await page.locator('.run-actions').boundingBox();
      assert.ok(button && row && bar);
      assert.ok(row.y >= button.y + button.height && row.y - button.y - button.height < 12, 'the schedule sits directly under Start/Pause');
      assert.ok(row.x >= bar.x && row.x + row.width <= bar.x + bar.width && row.y + row.height <= 900, 'the schedule stays inside the visible bottom bar');
    };
    await checkMobileSchedule('Start Auto apply');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'schedule details must wrap without overflowing the Apply page');
    const before = writes.filter(write => write.path === '/api/auto-apply').length;
    await page.getByRole('button', { name: 'Semi auto', exact: true }).click();
    await page.getByRole('button', { name: 'Start Semi auto', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/Starting enables 4 scheduled runs per 24 hours/).waitFor();
    const threshold = dialog.locator('[data-field=MIN_SCORE]');
    assert.equal(await threshold.getAttribute('min'), '60');
    assert.equal(await threshold.getAttribute('max'), '100');
    await threshold.fill(width === 1280 ? '59' : '101');
    await dialog.getByRole('button', { name: 'Start Semi auto', exact: true }).click();
    await dialog.getByText('Match threshold must be between 60% and 100%.', { exact: true }).waitFor();
    assert.equal(writes.filter(write => write.path === '/api/auto-apply').length, before, 'an invalid match threshold cannot authorize a run');
    const chosenScore = width === 1280 ? '60' : '100';
    await threshold.fill(chosenScore);
    assert.equal(await dialog.locator('[data-field=PAGES_PER_KEYWORD]').count(), 0, 'search depth is not a user control');
    for (const [key,max,label] of [['MAX_AGE_DAYS',30,'Max listing age'],['MAX_APPS_PER_DAY',100,'Daily application cap']] as const) {
      const input = dialog.locator(`[data-field=${key}]`);
      assert.equal(await input.getAttribute('max'),String(max));
      if (key === 'MAX_APPS_PER_DAY') assert.equal(await input.getAttribute('placeholder'),null,'daily applications never offer No limit');
      await input.fill(String(max+1));
      await dialog.getByRole('button',{name:'Start Semi auto',exact:true}).click();
      await dialog.getByText(`${label} must be between 1 and ${max}.`,{exact:true}).waitFor();
      assert.equal(writes.filter(write => write.path === '/api/auto-apply').length,before);
      await input.fill(String(max));
    }
    await dialog.getByRole('button', { name: 'Start Semi auto', exact: true }).click();
    await page.getByRole('button', { name: 'Pause Semi auto', exact: true }).waitFor();
    await schedule.getByText('Waiting to start', { exact: true }).waitFor();
    await checkMobileSchedule('Pause Semi auto');
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/schedule-active-${width}.png`), fullPage: true });
    assert.equal(writes.filter(write => write.path === '/api/auto-apply').length, before + 1);
    const start = writes.filter(write => write.path === '/api/auto-apply').at(-1)!.body;
    assert.equal(start.enabled, true); assert.equal(start.confirm, true); assert.equal(start.applicationMode, 'semi-auto');
    assert.equal(writes.filter(write => write.path === '/api/settings').at(-1)!.body.updates.MIN_SCORE, chosenScore);
    for (const [key,value] of Object.entries({MAX_AGE_DAYS:'30',MAX_APPS_PER_DAY:'100'})) assert.equal(writes.filter(write => write.path === '/api/settings').at(-1)!.body.updates[key],value);
    assert.equal(writes.filter(write => write.path === '/api/settings').at(-1)!.body.updates.PAGES_PER_KEYWORD, undefined);
    assert.equal(await page.getByRole('button', { name: 'Auto apply', exact: true }).isDisabled(), true);
    await page.reload();
    await page.getByRole('button', { name: 'Pause Semi auto', exact: true }).click();
    await page.getByText('Paused', { exact: true }).waitFor();
    assert.equal(writes.filter(write => write.path === '/api/auto-apply').at(-1)!.body.enabled, false);
    await page.reload();
    await page.getByText('Paused', { exact: true }).waitFor();
    await checkMobileSchedule('Start Semi auto');
    assert.equal(await page.getByRole('button', { name: 'Start Semi auto', exact: true }).count(), 1, 'mode and pause persist after reload');
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/schedule-controls-${width}.png`), fullPage: true });
    await page.goto(`${origin}/?tab=pricing`);
    for (const [name, runs] of [['Free', 1], ['Essential Pass', 2], ['Active Search', 4], ['Get Owtomated', 4]] as const) {
      const planCard = page.locator('.pricing-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
      await planCard.getByText(new RegExp(`${runs} scheduled run${runs === 1 ? '' : 's'} each day`)).waitFor();
      if (name === 'Active Search' || name === 'Get Owtomated') await planCard.getByText('Choose your minimum match score: 60% to 100%', { exact: true }).waitFor();
      if (name === 'Active Search') {
        await planCard.getByText('A$19.99', { exact: true }).waitFor();
        await planCard.getByText('30 days of access', { exact: true }).waitFor();
      }
    }
    const card = page.locator('.pricing-card').filter({ has: page.getByRole('heading', { name: 'Get Owtomated', exact: true }) });
    await card.getByText('A$59.99', { exact: true }).waitFor();
    await card.getByText('Unlimited applications', { exact: true }).last().waitFor();
    await card.getByText('Daily limit: 100 applications', { exact: true }).waitFor();
    await card.getByText('30 days of access', { exact: true }).waitFor();
    assert.equal(await page.locator('.pricing-topup').count(), 0, 'unlimited customers are not sold top-ups');
    assert.ok(await page.locator('.pricing-status').textContent().then(text => text?.includes('Unlimited')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pricing fits the mobile viewport');
    await page.screenshot({ path: resolve(import.meta.dirname, `../../output/scheduled-pricing-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: schedule start/pause persistence, selected mode, unlimited pricing on desktop/mobile, application controls, prepared retries, employer feeds, search-only tests, candidate answers and skipped retention notice; fixture APIs only');
} finally {
  await browser.close();
  await new Promise<void>(done => liveSockets.close(() => done()));
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
