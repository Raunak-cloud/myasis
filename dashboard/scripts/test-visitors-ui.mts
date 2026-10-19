import { PLAN_LIMITS } from '../src/pricing.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const { chromium } = createRequire(import.meta.url)(
  '../../seek-bot/node_modules/patchright',
) as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Serve only the built frontend and fixture APIs: no database, worker or employer is contacted.
const dist = resolve(import.meta.dirname, '../dist');
let admin = true;
let searchStarted = false;
let adminBoards = 'smartrecruiters';
let adminSeekSignedIn = false;
let attentionFixture = false;
let skippedFixture = false;
let liveFailure = false;
let liveRequests = 0;
const reportRequests: string[] = [];
const stamp = new Date().toISOString();
const visit = {
  sessionId: 'session-1',
  visitorId: 'customer-1',
  visitNumber: 1,
  startedAt: stamp,
  endedAt: stamp,
  views: 2,
  durationMs: null,
  pages: ['landing', 'run'],
  ip: '203.0.113.5',
  countryCode: 'AU',
  country: 'Australia',
  city: 'Sydney',
  region: 'New South Wales',
  email: 'customer@example.test',
  device: 'desktop',
  browser: 'Chrome',
  os: 'Windows',
  screen: null,
  language: 'en-AU',
  timeZone: 'Australia/Sydney',
  referrer: null,
  attributionSource: null,
  attributionMedium: null,
  attributionCampaign: null,
};
const writes: Array<{ path: string; body: any }> = [];
const settings = () => ({
  PLATFORMS: admin ? adminBoards : 'seek',
  SMARTRECRUITERS_COMPANIES: 'Canva,KPMGAustralia1,Colliers',
  KEYWORDS: 'software engineer',
  WORK_ARRANGEMENTS: 'remote,hybrid,onsite',
  ONSITE_CITY: 'Sydney',
  MIN_SALARY: '70000',
  MIN_SCORE: '60',
  MAX_AGE_DAYS: '14',
  MAX_APPS_PER_RUN: '5',
  MAX_APPS_PER_DAY: '20',
  MAX_EVALUATIONS: '40',
  PAGES_PER_KEYWORD: '1',
});
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://fixture').pathname;
  if (path.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST')
      writes.push({ path, body: JSON.parse(body || '{}') });
    if (
      path === '/api/run' &&
      req.method === 'POST' &&
      JSON.parse(body || '{}').mode === 'search'
    )
      searchStarted = true;
    const payloads: Record<string, unknown> = {
      '/api/auth/me': {
        user: {
          id: 'fixture',
          email: 'fixture@example.test',
          name: 'Fixture Candidate',
        },
        googleConfigured: true,
      },
      '/api/entitlements': {
        tier: admin ? 'admin' : 'standard',
        manualRuns: admin,
        firstRunRequired: !admin,
        autoRunsPerDay: 1,
        autoApplyPaused: true,
        canPauseAutoApply: true,
        autoRunsUsedToday: 0,
        scheduledMinScore: null,
        scheduledJobsPerDay: admin ? null : PLAN_LIMITS.free.evaluationsPerRun,
        evaluationsPerRun: admin ? null : PLAN_LIMITS.free.evaluationsPerRun,
        maxApplicationsPerRunOverride: null,
        fineTune: admin,
        advancedFilters: admin,
        indeedApplications: admin,
        runScopes: admin,
        humanizer: admin,
      },
      '/api/billing/status': {
        configured: true,
        totalRemaining: 5,
        free: { allowance: 5, used: 0, remaining: 5 },
        paid: {
          remaining: 0,
          employerSiteRemaining: 0,
          expiresAt: null,
          hasActivePass: false,
        },
      },
      '/api/signin/session': {
        supported: false,
        session: null,
        seek: { signedIn: !admin || adminSeekSignedIn },
        indeed: { signedIn: false },
      },
      '/api/setup/status': {
        ready: true,
        done: 3,
        total: 3,
        checks: ['resume', 'profile', 'looking'].map((id) => ({
          id,
          label: id,
          done: true,
          required: true,
        })),
      },
      '/api/run/status': {
        running: searchStarted,
        mode: searchStarted ? 'search' : null,
        startedAt: searchStarted ? new Date().toISOString() : null,
        finishedAt: null,
        applied: 0,
        isOwner: true,
      },
      '/api/run/last': { startedAt: null },
      '/api/run/stream': null,
      '/api/autorun': null,
      '/api/today': { runs: 0, reviewed: 0, submitted: 0 },
      '/api/applications': [],
      '/api/attention': attentionFixture
        ? [
            {
              jobId: 'handoff-fixture',
              title: 'Fixture Developer',
              company: 'Fixture Employer',
              kind: 'question',
              reason: 'Your answer is needed',
              at: new Date().toISOString(),
              url: 'https://fixture.invalid',
              questions: [
                {
                  question: 'Country of birth',
                  kind: 'select',
                  options: ['Australia', 'Canada'],
                },
                {
                  question: 'Audit services',
                  kind: 'select',
                  options: ['Unrelated skill'],
                },
              ],
            },
          ]
        : [],
      '/api/answers': { saved: 2 },
      '/api/skipped': {
        items: skippedFixture
          ? [
              {
                jobId: 'skip-fixture',
                title: 'Skipped Fixture Role',
                company: 'Fixture Employer',
                kind: 'fit',
                reason: 'Experience does not match',
                url: '',
                at: new Date().toISOString(),
                verdict: null,
                note: null,
              },
            ]
          : [],
      },
      '/api/board-resumes': { boards: [] },
      '/api/gmail/status': { connected: false },
      '/api/settings':
        req.method === 'POST' ? { ok: true, settings: settings() } : settings(),
      '/api/run': { ok: true, mode: 'live' },
    };
    if (path === '/api/admin/overview') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Overview not part of fixture' }));
      return;
    }
    if (path === '/api/admin/visitors/live') {
      liveRequests++;
      res.writeHead(liveFailure ? 503 : 200, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify(
          liveFailure
            ? { error: 'Fixture network unavailable' }
            : {
                generatedAt: stamp,
                activeWithinSeconds: 60,
                count: 1,
                visitors: [
                  {
                    visitorId: 'anonymous-visitor',
                    email: null,
                    page: 'pricing',
                    city: null,
                    region: null,
                    country: null,
                    browser: 'Chrome',
                    device: 'mobile',
                    lastSeenAt: stamp,
                  },
                ],
              },
        ),
      );
      return;
    }
    if (path === '/api/admin/visitors') {
      reportRequests.push(req.url!);
      const range = new URL(req.url!, 'http://fixture').searchParams.get(
        'range',
      );
      if (range === 'today') await new Promise((done) => setTimeout(done, 700));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          range,
          market: 'all',
          home: { code: 'AU', name: 'Australia' },
          timeZone: 'Australia/Sydney',
          retentionDays: 180,
          geoConfigured: true,
          totals: {
            visitors: range === '30d' ? 33 : range === 'today' ? 11 : 22,
            visits: 1,
            views: 2,
            signedIn: 1,
            located: 2,
            avgSeconds: null,
          },
          countries: [],
          regions: [],
          cities: [],
          pages: [],
          referrers: [],
          devices: [],
          browsers: [],
          days: [],
          addresses: { count: 203, list: [] },
          recent: [visit],
          ignored: [],
          yourAddress: '203.0.113.8',
        }),
      );
      return;
    }
    if (path === '/api/run/stream') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payloads[path] ?? {}));
    return;
  }
  const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(dist + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/html',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32'
    ? { channel: 'chrome' }
    : {
        executablePath:
          process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
      }),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.log('PAGE ERROR', error.message);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(`${origin}/?tab=admin`);
  console.log('fixture loaded');
  await page
    .getByRole('button', { name: 'Admin dashboard', exact: true })
    .click();
  await page.getByRole('button', { name: 'Visitors', exact: true }).click();
  console.log('Visitors opened');
  await page
    .getByTestId('live-count')
    .getByText('1', { exact: true })
    .waitFor();
  await page
    .getByRole('cell')
    .filter({ hasText: 'customer@example.test' })
    .waitFor();
  assert.equal(
    await page.getByLabel('Visitor location', { exact: true }).inputValue(),
    'all',
  );
  assert.equal(
    await page.getByText('Not recorded', { exact: true }).count(),
    2,
  );
  assert.equal(await page.getByText('first visit', { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('checkbox', { name: /Include admins/ }).count(),
    0,
  );
  assert.equal(
    await page.getByText('Location unavailable', { exact: true }).count(),
    1,
  );
  assert.equal(
    await page.locator('details[open]').count(),
    0,
    'advanced details stay collapsed',
  );
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: '30 days', exact: true }).click();
  await page.getByText('33', { exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert.equal(
    await page.getByText('11', { exact: true }).count(),
    0,
    'stale filter cannot overwrite history',
  );
  assert.ok(reportRequests.some((url) => url.includes('market=all')));
  const initialRequests = liveRequests;
  await page.waitForTimeout(10_500);
  assert.ok(liveRequests > initialRequests, 'live count polls automatically');
  liveFailure = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(/Live information unavailable/).waitFor();
  assert.equal(
    await page.getByTestId('live-count').innerText(),
    '\u2014',
    'outage never retains a live claim',
  );
  liveFailure = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByTestId('live-count')
    .getByText('1', { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const closeMenu = page.getByRole('button', {
    name: 'Close menu',
    exact: true,
  });
  if (await closeMenu.isVisible()) { await closeMenu.click(); await page.waitForTimeout(350); }
  assert.equal(
    await page
      .locator('.visitor-live tbody td')
      .first()
      .evaluate(
        (element) => (globalThis as any).getComputedStyle(element).display,
      ),
    'block',
    'mobile cells must become readable stacked cards',
  );
  assert.equal(
    await page.evaluate(() => {
      const win = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number } };
        innerWidth: number;
      };
      return win.document.documentElement.scrollWidth > win.innerWidth;
    }),
    false,
    'mobile must not overflow',
  );
  await page.screenshot({
    path: resolve(import.meta.dirname, '../../tmp/visitors-mobile-fixture.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: resolve(
      import.meta.dirname,
      '../../tmp/visitors-desktop-fixture.png',
    ),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    'PASS Visitors UI: live polling, outage/recovery, default all countries, no admin toggle, honest unknown time/location, collapsed details, stale filters and mobile layout; fixture APIs only',
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}
