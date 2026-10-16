import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Serve only the built frontend and fixture APIs: no database, worker or employer is contacted.
const dist = resolve(import.meta.dirname, '../dist');
let admin = true;
let searchStarted = false;
let adminBoards = 'smartrecruiters';
let adminSeekSignedIn = false;
let attentionFixture = false;
let costReads = 0;
let costFailure = false;
const writes: Array<{ path: string; body: any }> = [];
const settings = () => ({
  PLATFORMS: admin ? adminBoards : 'seek', SMARTRECRUITERS_COMPANIES: 'Canva,KPMGAustralia1,Colliers',
  KEYWORDS: 'software engineer', WORK_ARRANGEMENTS: 'remote,hybrid,onsite', ONSITE_CITY: 'Sydney',
  MIN_SALARY: '70000', MIN_SCORE: '60', MAX_AGE_DAYS: '14', MAX_APPS_PER_RUN: '5', MAX_APPS_PER_DAY: '20', MAX_EVALUATIONS: '40', PAGES_PER_KEYWORD: '1' });
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
    if (path === '/api/applications/costs') { costReads++; if (costFailure) { res.writeHead(503); res.end('{}'); return; } }
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
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 }, '/api/applications': [
        { jobId:'tracked', title:'Fixture AI Engineer', company:'Example Employer', location:'Sydney NSW', appliedAt:new Date().toISOString(), score:90, platform:'lever', url:'https://fixture.invalid/job' },
        { jobId:'legacy', title:'Historical Developer', company:'Historical Employer', location:'Sydney NSW', appliedAt:'2026-10-01T09:00:00Z', score:85, platform:'seek', url:'https://fixture.invalid/old' },
      ],
      '/api/applications/costs': { tracked: { currency:'USD', totalUsd:0.1428, knownCharges:4, incomplete:true, notes:['USD estimates before credits and taxes.','Shared costs are allocated equally across confirmed applications.'], lines:[
        {provider:'Celeris',model:'celeris-1-magnus',allocation:'direct',amountUsd:0.1128,knownCharges:3,unknownCharges:0,calls:3,details:['Usage includes cached input, reasoning and retries.']},
        {provider:'Bright Data',allocation:'direct',amountUsd:0.03,knownCharges:1,unknownCharges:0,calls:1,details:['Provider session bandwidth estimate.']},
        {provider:'Infrastructure',allocation:'shared',amountUsd:0,knownCharges:0,unknownCharges:1,calls:1,details:['Overhead not allocated.']},
      ] } }, '/api/site-accounts': [], '/api/skipped': {items:[]} ,
      '/api/attention': attentionFixture ? [{ jobId: 'handoff-fixture', title: 'Fixture Developer', company: 'Fixture Employer', kind: 'question', reason: 'Your answer is needed', at: new Date().toISOString(), url: 'https://fixture.invalid', questions: [{ question: 'Country of birth', kind: 'select', options: ['Australia', 'Canada'] }, { question: 'Audit services', kind: 'select', options: ['Unrelated skill'] }] }] : [],
      '/api/answers': { saved: 2 },
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
  mkdirSync(resolve(import.meta.dirname, '../../output'), { recursive: true });
  for (admin of [true, false]) {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const before = costReads;
      await page.goto(`${origin}/?tab=applications`);
      await page.getByText('Fixture AI Engineer', {exact:true}).waitFor();
      if (admin) {
        await page.getByText('US$0.1428 +', {exact:true}).waitFor();
        assert.equal(await page.getByText('Partial estimate', {exact:true}).count(),1);
        assert.equal(await page.getByText('Not recorded', {exact:true}).count(),1);
        if (width === 390) await page.waitForFunction("getComputedStyle(document.querySelector('.side-nav')).visibility === 'hidden'");
        assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'cost column must not create page overflow');
        await page.screenshot({path:resolve(import.meta.dirname, `../../output/application-cost-${width}.png`),fullPage:true});
        await page.getByText('Fixture AI Engineer', {exact:true}).click();
        const drawer=page.locator('.drawer');
        await drawer.getByRole('heading',{name:'Application cost (USD)'}).waitFor();
        assert.match(await drawer.innerText(), /Celeris.*celeris-1-magnus/s);
        assert.match(await drawer.innerText(), /Bright Data/);
        assert.match(await drawer.innerText(), /Infrastructure.*Unavailable/s);
        await drawer.getByRole('button',{name:'Close',exact:true}).click();
        await page.getByText('Historical Developer',{exact:true}).click();
        await page.getByText(/historical charges cannot be reconstructed reliably/).waitFor();
        await drawer.getByRole('button',{name:'Close',exact:true}).click();
        assert.equal(costReads,before+1);
      } else {
        assert.equal(await page.getByRole('columnheader',{name:'Cost (USD)'}).count(),0);
        assert.equal(await page.locator('.application-cost').count(),0);
        assert.equal(costReads,before,'normal user never requests internal costs');
        await page.getByText('Fixture AI Engineer',{exact:true}).click();
        assert.equal(await page.locator('.application-cost-details').count(),0);
      }
      assert.deepEqual(errors,[]);
      await context.close();
    }
  }
  admin=true; costFailure=true;
  const page=await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/?tab=applications`);
  await page.locator('.application-cost').first().getByText('Unavailable',{exact:true}).waitFor();
  console.log('Application cost UI: admin breakdown, old records, unknown costs, API failure, normal-user exclusion, desktop and mobile passed.');
} finally { await browser.close(); await new Promise<void>(done=>server.close(()=>done())); }
