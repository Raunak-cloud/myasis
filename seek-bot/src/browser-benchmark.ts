/** Read-only discovery benchmark. No forms, submissions, fit assessments or paid solvers. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { launchBrowser, closeBrowser, getPage, assertSignedIn } from './browser.js';
import { config } from './config.js';
import { search, fetchJobDetail } from './discovery.js';
import { hasCaptchaSurface } from './captcha/detect.js';

const fixture = process.argv.includes('--fixture');
const output = process.env.BENCHMARK_OUTPUT;
if (!output) throw new Error('BENCHMARK_OUTPUT is required');
if (config.dryRun !== true || process.env.CAPTCHA_SOLVER !== 'off') throw new Error('Benchmark requires DRY_RUN=true and CAPTCHA_SOLVER=off');
const start = performance.now();
const cpuTicks = new Map<number, number>();
const memory: number[] = [];
const clockTicks = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) : 100;
function sample() {
  if (process.platform !== 'linux') return;
  const all = new Map<number, { parent: number; ticks: number; own: boolean }>();
  for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const pid = Number(name), stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      all.set(pid, { parent: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), own: command.includes(`--user-data-dir=${config.userDataDir}`) });
    } catch { /* Processes may exit during sampling. */ }
  }
  const pids = new Set([...all].filter(([, value]) => value.own).map(([pid]) => pid));
  for (let n = 0; n < 12; n++) for (const [pid, value] of all) if (pids.has(value.parent)) pids.add(pid);
  let pss = 0;
  for (const pid of pids) {
    cpuTicks.set(pid, all.get(pid)!.ticks);
    try { pss += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0); } catch { /* Exited process. */ }
  }
  if (pss) memory.push(pss / 1024);
}
const result: Record<string, unknown> = { mode: config.headless ? 'headless' : 'headed', fixture, at: new Date().toISOString(), searches: [], details: [], httpErrors: [], challenges: 0, aiCalls: 0, paidSolves: 0, submissions: 0 };
const ctx = await launchBrowser();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  // A timed-out benchmark must release its own Chrome/profile too.
  void closeBrowser(ctx).finally(() => process.exit(143));
});
result.launchMs = performance.now() - start;
const sampler = setInterval(sample, 500);
let controller: Awaited<ReturnType<typeof ctx.newCDPSession>> | undefined;
let bytes = 0;
let frames = 0;
let challengeTimer: ReturnType<typeof setInterval> | undefined;
try {
  const page = await getPage(ctx);
  let checkingChallenge = false, challengeVisible = false;
  challengeTimer = setInterval(() => {
    if (checkingChallenge) return;
    checkingChallenge = true;
    void hasCaptchaSurface(page).then(visible => {
      if (visible && !challengeVisible) result.challenges = Number(result.challenges) + 1;
      challengeVisible = visible;
    }).catch(() => {}).finally(() => { checkingChallenge = false; });
  }, 1000);
  page.setDefaultNavigationTimeout(45_000);
  if (fixture) {
    const cards = Array.from({ length: 32 }, (_, i) => `<article data-automation="normalJob" data-job-id="${100000 + i}"><a data-automation="jobTitle" href="/job/${100000 + i}">Software Engineer ${i}</a><span data-automation="jobCompany">Fixture Employer</span><span data-automation="jobCardLocation">Sydney NSW</span><span data-automation="jobSalary">$100,000 – $120,000</span><span data-automation="jobListingDate">1d ago</span></article>`).join('');
    await ctx.route('https://benchmark.invalid/**', route => route.fulfill({ contentType: 'text/html', body: `<html><body>${cards}<div data-automation="jobAdDetails">${'Build reliable software. '.repeat(200)}</div><span data-automation="job-detail-salary">$100,000</span><span data-automation="job-detail-date">1d ago</span><span data-automation="job-detail-location">Sydney NSW</span><span data-automation="job-detail-work-type">Full time</span><a data-automation="job-detail-apply" href="/apply">Quick Apply</a><script>setInterval(()=>{document.body.dataset.tick=Date.now();document.body.style.backgroundColor=Date.now()%2?'white':'#fafafa'},300)</script></body></html>` }));
    result.persistedCookie = (await ctx.cookies('https://benchmark.invalid')).some(cookie => cookie.name === 'benchmark-session');
    await ctx.addCookies([{ name: 'benchmark-session', value: 'fixture', domain: 'benchmark.invalid', path: '/', expires: Date.now() / 1000 + 3600 }]);
  }
  controller = await ctx.newCDPSession(page);
  await controller.send('Network.enable');
  controller.on('Network.loadingFinished', event => { bytes += event.encodedDataLength; });
  controller.on('Page.screencastFrame', event => { frames++; void controller?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
  await controller.send('Page.enable');
  await controller.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1200, maxHeight: 1200 });
  page.on('response', response => { if (response.request().isNavigationRequest() && response.status() >= 400) (result.httpErrors as unknown[]).push({ status: response.status(), host: new URL(response.url()).hostname }); });
  if (!fixture) {
    const before = performance.now();
    await assertSignedIn(page, 20_000, 15_000);
    const text = await page.locator('body').innerText();
    result.session = /profile visibility|profile strength|career history|profile activity/i.test(text) ? 'signed-in' : 'unclear';
    result.sessionMs = performance.now() - before;
  }
  const keywords = config.keywords.slice(0, fixture ? 1 : 2);
  for (const keyword of keywords) {
    if (!fixture) await new Promise(done => setTimeout(done, config.limits.searchDelayMs * 1.4));
    const before = performance.now();
    const jobs = await search(page, keyword);
    (result.searches as unknown[]).push({ keyword, ms: performance.now() - before, count: jobs.length, unique: new Set(jobs.map(job => job.id)).size, ids: jobs.map(job => job.id), complete: jobs.every(job => job.title && job.url && job.location !== 'Unknown') });
    if (await hasCaptchaSurface(page)) result.challenges = Number(result.challenges) + 1;
    for (const job of jobs.slice(0, fixture ? 1 : 2)) {
      if (!fixture) await new Promise(done => setTimeout(done, config.limits.searchDelayMs * 1.4));
      const beforeDetail = performance.now();
      const detail = await fetchJobDetail(page, job);
      (result.details as unknown[]).push({ id: job.id, ms: performance.now() - beforeDetail, descriptionChars: detail.description?.length ?? 0, descriptionHash: createHash('sha256').update(detail.description ?? '').digest('hex'), mode: detail.applicationMode });
      if (await hasCaptchaSurface(page)) { result.challenges = Number(result.challenges) + 1; throw new Error('Challenge observed; benchmark stopped'); }
    }
  }
  result.screenshotBytes = (await page.screenshot({ type: 'jpeg', quality: 60 })).length;
  result.liveFrames = frames;
  result.browser = await page.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: navigator.webdriver, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] }));
  result.ok = (result.searches as Array<{ count: number }>).every(row => row.count > 0) && (result.details as Array<{ descriptionChars: number }>).every(row => row.descriptionChars > 0);
} catch (error) {
  result.ok = false;
  result.error = (error as Error).message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 500);
  const page = ctx.pages()[0];
  if (page && await hasCaptchaSurface(page).catch(() => false)) result.challenges = Number(result.challenges) + 1;
} finally {
  clearInterval(sampler);
  clearInterval(challengeTimer);
  sample();
  result.networkBytes = bytes;
  result.meanPssMiB = memory.length ? memory.reduce((a, b) => a + b, 0) / memory.length : null;
  result.peakPssMiB = memory.length ? Math.max(...memory) : null;
  result.browserCpuSeconds = process.platform === 'linux' ? [...cpuTicks.values()].reduce((a, b) => a + b, 0) / clockTicks : null;
  result.activeMs = performance.now() - start;
  await controller?.detach().catch(() => {});
  await closeBrowser(ctx);
  result.totalMs = performance.now() - start;
  // A wall judgement can use the existing model; count it rather than claiming zero spend.
  try {
    const metrics = readFileSync(resolve(config.dataDir, 'pipeline-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const model = metrics.filter(row => row.stage === 'model');
    result.aiCalls = model.length;
    result.modelUsage = model.map(row => row.usage);
  } catch { /* No model calls. */ }
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mode: result.mode, fixture, ok: result.ok, totalMs: result.totalMs, meanPssMiB: result.meanPssMiB, error: result.error }));
}
