/** Offline browser integration matrix. Uses the production launcher and readers,
 * synthetic profiles, a loopback HTTP server and a deny-by-default network route.
 * Never contacts job boards, models or paid solvers. Run compiled, not through tsx. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'patchright';

const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
const destination = process.env.FIXTURE_OUTPUT;
if (!destination || !['headed', 'headless'].includes(mode ?? '')) throw new Error('FIXTURE_OUTPUT and --mode=headed|headless required');
mkdirSync(destination, { recursive: true });
const directory = mkdtempSync(resolve(destination, 'profiles-'));
Object.assign(process.env, {
  HEADLESS: String(mode === 'headless'), BACKGROUND: 'true', BROWSER_CONNECT_CDP: 'false',
  BROWSER_PROXY_SERVER: '', RUN_VIDEO_DIR: '', CHROME_PROFILE_DIR: resolve(directory, 'a'),
  DATA_DIR: resolve(directory, 'data'), DRY_RUN: 'true', CAPTCHA_SOLVER: 'off',
  CAPMONSTER_API_KEY: '', BRIGHTDATA_ENABLED: 'false', BRIGHTDATA_ADMIN_ONLY: 'false',
  CELERIS_API_KEY: 'offline-fixtures-only', SEARCH_LOCATION: 'Sydney NSW', SEARCH_RADIUS_KM: '25', MAX_AGE_DAYS: '14',
});
mkdirSync(process.env.DATA_DIR!, { recursive: true });
const requests: Array<{ path: string; method: string }> = [];
const html = (body: string, title = 'Offline jobs') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const cards = (start: number, count = 3, sparse = false) => Array.from({ length: count }, (_, n) => `<article data-automation="normalJob" data-job-id="${start + n}"><a data-automation="jobTitle" href="/job/${start + n}">Engineer &amp; AI — café ${n}</a>${sparse ? '' : '<span data-automation="jobCompany">Fixture &amp; Co</span><span data-automation="jobCardLocation">Sydney NSW</span><span data-automation="jobSalary">$90,000 – $120,000</span><span data-automation="jobListingDate">3d ago</span>'}</article>`).join('');
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  requests.push({ path: url.pathname, method: req.method! });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/hang') return; // Deliberately cancelled by the timeout test.
  if (url.pathname === '/drop') { req.socket.destroy(); return; }
  if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/plain' }); res.end(); return; }
  if (/^\/status\//.test(url.pathname)) { res.statusCode = Number(url.pathname.split('/')[2]); res.end(html('<main>Service unavailable</main>')); return; }
  if (url.pathname === '/jobs') {
    const keyword = url.searchParams.get('keywords');
    if (keyword === 'empty') { res.end(html('<main id="empty">No matching jobs</main>')); return; }
    const payload = cards(url.searchParams.has('page') ? 200 : 100, 3, keyword === 'sparse');
    res.end(keyword === 'delayed' ? html(`<main id="results">Loading</main><script>fetch('/payload').then(r=>r.text()).then(t=>document.querySelector('#results').innerHTML=t)</script>`) : html(payload)); return;
  }
  if (url.pathname === '/payload') { setTimeout(() => { if (!res.destroyed) res.end(cards(300)); }, 250); return; }
  if (url.pathname.startsWith('/job/')) {
    const id = url.pathname.split('/')[2];
    const variants: Record<string, string> = {
      '100': '<span data-automation="job-detail-salary">$105,000</span><span data-automation="job-detail-date">today</span><span data-automation="job-detail-location">Parramatta NSW</span><span data-automation="job-detail-work-type">Full time</span><a data-automation="job-detail-apply" href="/apply/100">Quick Apply</a>',
      '101': '<a data-automation="job-detail-apply" href="https://employer.invalid/apply/101">Apply</a><p>You applied on 1 October 2026</p>',
      '102': '<a data-automation="job-detail-apply" href="/apply/102">Quick&nbsp; Apply</a><p>You are a strong applicant for this role</p>',
    };
    const detail = `<div data-automation="jobAdDetails">Build reliable software — accessibility &amp; internationalisation.</div>${variants[id] ?? ''}`;
    res.end(id === '300' ? html(`<div id="target"></div><script>setTimeout(()=>document.querySelector('#target').innerHTML=${JSON.stringify(detail)},250)</script>`) : html(detail)); return;
  }
  if (url.pathname === '/animate') { res.end(html('<main style="font-size:40px">LIVE FIXTURE <span id="tick"></span></main><script>setInterval(()=>{document.querySelector("#tick").textContent=Date.now();document.body.style.background=Date.now()%2?"#ddd":"#fff"},50)</script>')); return; }
  if (url.pathname === '/popup') { res.end(html('<button onclick="window.open(\'/plain\')">Open test tab</button>')); return; }
  if (url.pathname === '/form') { res.end(html('<form><label for="name">Full name</label><input id="name" name="fullName" required><label for="email">Email</label><input id="email" type="email" required><label for="country">Country</label><select id="country"><option>Australia</option><option>New Zealand</option></select><button type="submit">Submit application</button></form>')); return; }
  res.end(html('<main id="ready">Fixture ready</main>'));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
process.env.SEEK_BASE = base;
const { launchBrowser, closeBrowser, getPage, waitForChallengeToClear } = await import('./browser.js');
const { searchViaDom, searchUrl, fetchJobDetail } = await import('./discovery.js');
const { detectChallenge, hasCaptchaSurface } = await import('./captcha/detect.js');
const { extractFields } = await import('./dom.js');
const { config } = await import('./config.js');
const checks: Array<{ name: string; ok: boolean; ms: number; error?: string }> = [];
const measurements: Record<string, unknown> = {};
let ctx: BrowserContext | undefined, page: Page;
let blockedExternal = 0;
// Browser routing does not cover Node-side model/solver HTTP calls. Deny those
// too, allowing only the local CDP endpoint used by the port-release check.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== `http://127.0.0.1:${process.env.CDP_PORT}`) {
    blockedExternal++; throw new Error('Off-host Node fetch blocked by offline fixture');
  }
  return nativeFetch(input, init);
}) as typeof fetch;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void (async () => {
    if (ctx) await closeBrowser(ctx).catch(() => {});
    server.closeAllConnections(); server.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(143);
  })();
});
async function open(profile: string) {
  config.userDataDir = resolve(directory, profile);
  ctx = await launchBrowser();
  ctx.setDefaultTimeout(5000);
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base) await route.continue();
    else if (url.hostname.endsWith('.fixture.invalid')) await route.fulfill({ contentType: 'text/html', body: html('Synthetic iframe') });
    else { blockedExternal++; await route.abort('blockedbyclient'); }
  });
  page = await getPage(ctx);
  page.setDefaultNavigationTimeout(5000);
}
async function check(name: string, fn: () => Promise<void>) {
  const before = performance.now();
  try { await fn(); checks.push({ name, ok: true, ms: performance.now() - before }); }
  catch (error) {
    checks.push({ name, ok: false, ms: performance.now() - before, error: (error as Error).message.slice(0, 700) });
    await page?.screenshot({ path: resolve(destination!, `${checks.length}-failure.png`), timeout: 2000 }).catch(() => {});
  }
}
async function eventually(test: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!test() && Date.now() < until) await new Promise(done => setTimeout(done, 25));
  assert(test(), 'Condition did not become true before deadline');
}
const start = performance.now();
try {
  await open('a');
  await check('native browser window and rendered screenshot', async () => {
    await page.goto(`${base}/plain`);
    measurements.browser = await page.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: navigator.webdriver, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] }));
    assert((await page.screenshot({ path: resolve(destination!, `${mode}.png`) })).length > 1000);
    const size = await page.evaluate(() => [innerWidth, innerHeight]);
    assert(size[0] > 1000 && size[1] > 500);
  });
  await check('search preferences survive URL encoding', async () => {
    const url = new URL(searchUrl('C++ & AI / café', 2));
    assert.equal(url.searchParams.get('keywords'), 'C++ & AI / café');
    assert.equal(url.searchParams.get('where'), 'Sydney NSW');
    assert.equal(url.searchParams.get('distance'), '25');
    assert.equal(url.searchParams.get('daterange'), '14');
    assert.equal(url.searchParams.get('page'), '2');
  });
  await check('real search reader extracts unicode, fields and dates', async () => {
    const jobs = await searchViaDom(page, 'normal');
    assert.deepEqual(jobs.map(j => j.id), ['100', '101', '102']);
    assert.equal(jobs[0].title, 'Engineer & AI — café 0'); assert.equal(jobs[0].company, 'Fixture & Co');
    assert.equal(jobs[0].location, 'Sydney NSW'); assert.equal(jobs[0].ageDays, 3); assert.equal(jobs[0].salary, '$90,000 – $120,000');
  });
  await check('pagination reads a different set without stale cards', async () => {
    const jobs = await searchViaDom(page, 'normal', 2);
    assert.deepEqual(jobs.map(j => j.id), ['200', '201', '202']);
  });
  await check('delayed SPA search waits for asynchronous cards', async () => {
    assert.deepEqual((await searchViaDom(page, 'delayed')).map(j => j.id), ['300', '301', '302']);
  });
  await check('missing optional listing fields stay unknown', async () => {
    const job = (await searchViaDom(page, 'sparse'))[0];
    assert.equal(job.company, 'Unknown'); assert.equal(job.location, 'Unknown'); assert.equal(job.salary, undefined); assert.equal(job.ageDays, undefined);
  });
  await check('empty DOM results do not fabricate listings', async () => {
    await page.goto(searchUrl('empty'));
    assert.deepEqual(await searchViaDom(page, 'empty'), []);
  });
  const job = { id: '100', title: 'Fixture engineer', company: 'Fixture', location: 'Sydney NSW', salary: '$90,000', url: `${base}/job/100` };
  await check('detail reader finds hosted CTA and overrides listing fields', async () => {
    const detail = await fetchJobDetail(page, job);
    assert.equal(detail.description, 'Build reliable software — accessibility & internationalisation.');
    assert.equal(detail.salary, '$105,000'); assert.equal(detail.location, 'Parramatta NSW'); assert.equal(detail.applicationMode, 'hosted'); assert.equal(detail.applicationUrl, `${base}/apply/100`);
  });
  await check('external CTA and existing application are recognised without submission', async () => {
    const detail = await fetchJobDetail(page, { ...job, id: '101', url: `${base}/job/101` });
    assert.equal(detail.applicationMode, 'external'); assert.equal(detail.applicationUrl, 'https://employer.invalid/apply/101'); assert(detail.alreadyApplied); assert.equal(detail.salary, '$90,000');
  });
  await check('strong applicant and whitespace in hosted CTA', async () => {
    const detail = await fetchJobDetail(page, { ...job, id: '102', url: `${base}/job/102` });
    assert(detail.strongApplicant); assert.equal(detail.applicationMode, 'hosted');
  });
  await check('delayed detail rendering and absent CTA', async () => {
    const detail = await fetchJobDetail(page, { ...job, id: '300', url: `${base}/job/300` });
    assert(detail.description?.includes('internationalisation')); assert.equal(detail.applicationMode, 'unknown'); assert.equal(detail.applicationUrl, undefined);
  });
  for (const status of [403, 429, 503]) await check(`HTTP ${status} preserved for diagnostics`, async () => { assert.equal((await page.goto(`${base}/status/${status}`))?.status(), status); });
  await check('redirect is followed without losing page control', async () => { await page.goto(`${base}/redirect`); assert.equal(page.url(), `${base}/plain`); });
  await check('navigation timeout recovers on next navigation', async () => {
    await assert.rejects(page.goto(`${base}/hang`, { timeout: 500 }), /Timeout/);
    await page.goto(`${base}/plain`); assert.equal(await page.locator('#ready').innerText(), 'Fixture ready');
  });
  await check('failed connection in one tab does not poison the browser context', async () => {
    const failedTab = await ctx!.newPage();
    try { await assert.rejects(failedTab.goto(`${base}/drop`), /ERR_EMPTY_RESPONSE|ERR_CONNECTION/); }
    finally { await failedTab.close(); }
    await page.goto(`${base}/plain`); assert(await page.locator('#ready').isVisible());
  });
  await check('form observation preserves labels and required fields', async () => {
    await page.goto(`${base}/form`);
    const fields = await extractFields(page);
    assert(fields.some(f => /full name/i.test(f.label) && f.required));
    assert(fields.some(f => /email/i.test(f.label) && f.required));
    assert(fields.some(f => /country/i.test(f.label)));
  });
  const challenges = [
    { name: 'Cloudflare full-page challenge', body: '<div id="challenge-running">Waiting</div>', title: 'Just a moment', expected: true, kind: 'cloudflare-challenge' },
    { name: 'unsolved Turnstile', body: '<div class="cf-turnstile" data-sitekey="0x-fixture"></div>', expected: true, kind: 'turnstile' },
    { name: 'solved Turnstile', body: '<div class="cf-turnstile" data-sitekey="0x-fixture"></div><input name="cf-turnstile-response" value="synthetic-token">', expected: false },
    { name: 'visible hCaptcha puzzle', body: '<iframe src="https://hcaptcha.com.fixture.invalid/puzzle" width="300" height="200"></iframe>', expected: true },
    { name: 'hidden hCaptcha puzzle', body: '<iframe src="https://hcaptcha.com.fixture.invalid/puzzle" style="display:none"></iframe>', expected: false },
    { name: 'offscreen hCaptcha puzzle', body: '<iframe src="https://hcaptcha.com.fixture.invalid/puzzle" style="position:absolute;top:-10000px;width:300px;height:200px"></iframe>', expected: false },
    { name: 'invisible hCaptcha checkbox', body: '<iframe src="https://hcaptcha.com.fixture.invalid/?frame=checkbox-invisible" width="300" height="200"></iframe>', expected: false },
    { name: 'ordinary challenge-form id is not a Cloudflare wall', body: '<form id="challenge-form"><label>Name<input></label></form>', expected: false },
  ];
  for (const fixture of challenges) await check(`CAPTCHA recognition: ${fixture.name}`, async () => {
    await page.setContent(html(fixture.body, fixture.title));
    assert.equal(await hasCaptchaSurface(page), fixture.expected);
    if ('kind' in fixture) assert.equal((await detectChallenge(page))?.kind, fixture.kind);
  });
  await check('unresolved verification has a bounded wait, no solver calls', async () => {
    await page.setContent(html('<div id="challenge-running">Waiting</div>', 'Just a moment'));
    const before = performance.now(); assert.equal(await waitForChallengeToClear(page, 600), false); assert(performance.now() - before < 3000);
  });
  await check('self-clearing verification returns to normal page', async () => {
    await page.setContent(html('<div id="challenge-running">Waiting</div><script>setTimeout(()=>{document.title="Jobs";document.body.innerHTML="Ready"},250)</script>', 'Just a moment'));
    assert.equal(await waitForChallengeToClear(page, 2500), true);
  });
  await check('CDP live frames, navigation and reconnect', async () => {
    let frames = 0;
    async function stream() {
      const session = await ctx!.newCDPSession(page);
      session.on('Page.screencastFrame', event => { frames++; void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
      await session.send('Page.enable'); await session.send('Page.startScreencast', { format: 'jpeg', quality: 60 }); return session;
    }
    await page.goto(`${base}/animate`);
    const first = await stream(); await eventually(() => frames >= 2); await first.detach();
    const before = frames; const second = await stream();
    await page.goto(`${base}/plain`); await page.goto(`${base}/animate`);
    await eventually(() => frames >= before + 2); await second.detach(); measurements.liveFrames = frames;
  });
  await check('popup closure and replacing a working tab keep the context usable', async () => {
    await page.goto(`${base}/popup`);
    const opened = page.waitForEvent('popup'); await page.getByRole('button').click(); const popup = await opened;
    await popup.waitForLoadState('domcontentloaded'); assert.equal(popup.url(), `${base}/plain`); await popup.close();
    // Closing the last native headed window may exit Chrome. Preserve a tab,
    // just as a worker must when replacing its current page mid-run.
    const replacement = await ctx!.newPage();
    await page.close(); page = await getPage(ctx!); assert.equal(page, replacement);
    await page.goto(`${base}/plain`); assert(await page.locator('#ready').isVisible());
  });
  await check('100 navigations preserve extraction and usable live screenshot', async () => {
    const before = performance.now();
    for (let n = 0; n < 100; n++) { const jobs = await searchViaDom(page, `soak-${n}`, n % 2 + 1); assert.equal(jobs.length, 3); assert.equal(jobs[0].id, n % 2 ? '200' : '100'); }
    measurements.soakNavigations = 100; measurements.soakMs = performance.now() - before;
    assert((await page.screenshot()).length > 1000);
  });
  await check('persistent account cookie and localStorage survive clean relaunch', async () => {
    await page.goto(`${base}/plain`);
    await ctx!.addCookies([{ name: 'account', value: 'fixture-a', url: base, expires: Date.now() / 1000 + 3600 }]);
    await page.evaluate(() => { localStorage.setItem('owner', 'fixture-a'); sessionStorage.setItem('temporary', 'tab-a'); });
    await closeBrowser(ctx!); ctx = undefined; await open('a'); await page.goto(`${base}/plain`);
    assert.equal((await ctx!.cookies(base)).find(c => c.name === 'account')?.value, 'fixture-a');
    assert.equal(await page.evaluate(() => localStorage.getItem('owner')), 'fixture-a');
  });
  await check('separate account profile cannot read another account storage', async () => {
    await closeBrowser(ctx!); ctx = undefined; await open('b'); await page.goto(`${base}/plain`);
    assert.equal((await ctx!.cookies(base)).find(c => c.name === 'account'), undefined);
    assert.equal(await page.evaluate(() => localStorage.getItem('owner')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('temporary')), null);
    await page.evaluate(() => localStorage.setItem('owner', 'fixture-b'));
    await closeBrowser(ctx!); ctx = undefined; await open('a'); await page.goto(`${base}/plain`);
    assert.equal(await page.evaluate(() => localStorage.getItem('owner')), 'fixture-a');
  });
  await check('no fixture application POST or off-host service call', async () => {
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
    assert.equal(blockedExternal, 0);
    assert.equal(config.dryRun, true);
    const metrics = resolve(config.dataDir, 'pipeline-metrics.jsonl');
    if (existsSync(metrics)) assert.equal(readFileSync(metrics, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row)).filter(row => row.stage === 'model').length, 0);
  });
  await check('closing the context releases its loopback live-view port', async () => {
    const endpoint = `http://127.0.0.1:${process.env.CDP_PORT}/json/version`;
    assert.equal((await fetch(endpoint)).status, 200);
    await closeBrowser(ctx!); ctx = undefined;
    const listening = await new Promise<boolean>(done => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.CDP_PORT) });
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
      socket.setTimeout(2000, () => { socket.destroy(); done(true); });
    });
    assert.equal(listening, false);
  });
} finally {
  if (ctx) await closeBrowser(ctx);
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  rmSync(directory, { recursive: true, force: true });
  const result = { at: new Date().toISOString(), mode, os: process.platform, ok: checks.length > 0 && checks.every(c => c.ok), checks, measurements, requests: requests.length, blockedExternal, totalMs: performance.now() - start, scope: 'Offline synthetic browser fixtures; no real-site detection or real submission test' };
  writeFileSync(resolve(destination!, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mode, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).map(c => ({ name: c.name, error: c.error })), totalMs: result.totalMs }));
  if (!result.ok) process.exitCode = 1;
}
