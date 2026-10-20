import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-smartrecruiters-fixture-'));
process.env.BRIGHTDATA_BROWSER_ENABLED = 'false';
process.env.EMPLOYER_BROWSER_PROVIDER = 'local';
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'true';
process.env.DRY_RUN = 'false';
process.env.APPLY_ONLY = 'all';
const { applyToEmployerJob } = await import('./apply-employer-job.js');
const { smartRecruitersListing } = await import('../smartrecruiters.js');
const { config } = await import('../config.js');
const job = smartRecruitersListing({
  id: '123456789', name: 'Fixture Developer', company: { identifier: 'FixtureEmployer', name: 'Fixture Employer' },
  location: { city: 'Sydney', country: 'au' }, visibility: 'PUBLIC',
}, 'FixtureEmployer')!;
const sourceJobs = [
  { platform: 'lever', url: 'https://jobs.lever.co/FixtureEmployer/11111111-2222-4333-8444-555555555555' },
  { platform: 'greenhouse', url: 'https://job-boards.greenhouse.io/FixtureEmployer/jobs/123' },
  { platform: 'pageup', url: 'https://careers.pageuppeople.com/999/cw/en/job/123/fixture-developer' },
  { platform: 'workday', url: 'https://fixture.wd105.myworkdayjobs.com/en-US/External/job/Sydney/Fixture-Developer_JR123' },
] as const;
const fixtureUrls = new Set([job.url, ...sourceJobs.map(source => source.url)]);
const profile = { name: 'Fixture Candidate', email: 'fixture@example.test' } as import('../types.js').CandidateProfile;
const deps = { onFriction: () => {} };
const noBrowser = new Proxy({} as Page, { get: () => { throw new Error('Refused request reached browser'); } });

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'false';
  assert.equal((await applyToEmployerJob(noBrowser, job, profile, deps)).status, 'skipped');
  process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'true';
  config.allowExternalApply = false;
  assert.equal((await applyToEmployerJob(noBrowser, job, profile, deps)).status, 'skipped');
  config.allowExternalApply = true;
  process.env.APPLY_ONLY = 'hosted';
  assert.equal((await applyToEmployerJob(noBrowser, job, profile, deps)).status, 'skipped');
  process.env.APPLY_ONLY = 'all';
  config.dryRun = true;
  assert.equal((await applyToEmployerJob(noBrowser, job, profile, deps)).status, 'skipped');
  config.dryRun = false;
  await assert.rejects(applyToEmployerJob(noBrowser, { ...job, applicationUrl: 'https://localhost/private' }, profile, deps), /public jobs website/);

  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  const context = await browser.newContext();
  const page = await context.newPage();
  let networkRequests = 0;
  // Every browser request is fulfilled locally or refused; no employer receives an application.
  await page.route('**/*', route => {
    networkRequests++;
    if (!fixtureUrls.has(route.request().url())) return route.abort();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main><h1>Fixture Developer</h1>
      <form onsubmit="event.preventDefault();document.title='Fixture submitted'">
      <label>Email<input type="email" name="email" required></label><button type="submit">Submit application</button></form></main>` });
  });
  let guards = 0;
  let released = 0;
  const guard = async () => { guards++; return { blocked: () => null, stop: async () => { released++; } }; };
  let calls = 0;
  const result = await applyToEmployerJob(page, job, profile, deps, { guard, runAgent: async options => {
    calls++;
    assert.equal(options.job.id, job.id);
    assert.equal(options.profile.email, profile.email);
    await options.page.locator('input[name=email]').fill(profile.email);
    await options.page.getByRole('button', { name: 'Submit application' }).click();
    assert.equal(await options.page.title(), 'Fixture submitted');
    await options.page.context().newPage();
    return { outcome: { status: 'applied' }, captured: [{ question: 'Email', answer: profile.email }], actions: [],
      submitPressed: true, site: 'jobs.smartrecruiters.com', steps: 1, usage: 'local fixture; no model call' };
  } });
  assert.equal(result.status, 'applied');
  assert.equal(result.submitPressed, true);
  assert.equal(calls, 1);
  assert.equal(guards, 1);
  assert.equal(released, 1);
  assert.equal(networkRequests, 1);
  assert.equal(page.context().pages().length, 1, 'extra application tabs are closed');
  await assert.rejects(applyToEmployerJob(page, job, profile, deps, { guard,
    runAgent: async () => { throw new Error('Fixture agent failed'); },
  }), /Fixture agent failed/);
  assert.equal(released, 2, 'navigation guard is removed even when the agent fails');
  for (const source of sourceJobs) {
    const target = { ...job, id: `${source.platform}-fixture`, platform: source.platform, url: source.url, applicationUrl: source.url };
    const outcome = await applyToEmployerJob(page, target, profile, deps, { guard, runAgent: async options => {
      assert.equal(options.job.platform, source.platform);
      await options.page.locator('input[name=email]').fill(profile.email);
      await options.page.getByRole('button', { name: 'Submit application' }).click();
      assert.equal(await options.page.title(), 'Fixture submitted');
      return { outcome: { status: 'applied' }, captured: [], actions: [], submitPressed: true, site: new URL(source.url).host, steps: 1, usage: 'local fixture; no employer transmission' };
    } });
    assert.equal(outcome.status, 'applied'); assert.equal(outcome.jobId, target.id);
    await assert.rejects(applyToEmployerJob(noBrowser, { ...target, applicationUrl: 'https://localhost/private' }, profile, deps));
    process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'false';
    assert.equal((await applyToEmployerJob(noBrowser, target, profile, deps)).status, 'skipped');
    process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'true';
  }
  assert.equal(released, 6, 'every provider releases its navigation guard');
  // A separate browser session reaches the same agent and always closes,
  // including failures before the agent starts. No existing account cookie follows it.
  await context.addCookies([{ name: 'account-session', value: 'fixture-private', url: job.url }]);
  let closedSessions = 0;
  const openBrowser = async () => {
    const owned = await browser!.newContext();
    assert.equal((await owned.cookies()).length, 0);
    const remotePage = await owned.newPage();
    await remotePage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><form><input type=file aria-label=Resume><button>Submit application</button></form></main>' }));
    return { page: remotePage, close: async () => { closedSessions++; await owned.close(); } };
  };
  await applyToEmployerJob(page, job, profile, deps, { guard, openBrowser, runAgent: async options => {
    assert.notEqual(options.page.context(), context);
    await options.page.getByLabel('Resume').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture resume') });
    assert.equal(await options.page.getByLabel('Resume').evaluate((el: HTMLInputElement) => el.files?.[0]?.name), 'fixture.txt');
    return { outcome: { status: 'needs-human', reason: 'Fixture only' }, captured: [], actions: [], submitPressed: false, site: 'fixture', steps: 1, usage: 'no employer transmission' };
  } });
  await assert.rejects(applyToEmployerJob(page, job, profile, deps, { openBrowser, guard: async () => { throw new Error('Fixture guard setup failed'); } }), /Fixture guard setup failed/);
  await assert.rejects(applyToEmployerJob(page, job, profile, deps, { openBrowser, guard, runAgent: async () => { throw new Error('Fixture private session failed'); } }), /Fixture private session failed/);
  const reports = readFileSync(join(directory, 'traces', `${job.id}.failures.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const failure = reports.find(report => report.error.message === 'Fixture private session failed');
  assert.equal(failure.pageClosed, false, 'error evidence is captured before owned-browser cleanup');
  assert.equal(failure.browserConnected, true);
  assert.equal(failure.stage, 'employer-application');
  assert.equal(closedSessions, 3, 'successful, failed agent and failed guard sessions all close');
  assert.equal((await context.cookies())[0]?.value, 'fixture-private', 'the original browser remains owned and usable');
  console.log('PASS: admin, external scope and dry-run gates; public-feed handoff to application agent; local form only; guard cleanup');
} finally {
  await browser?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('owtomate-smartrecruiters-fixture-'));
  rmSync(directory, { recursive: true, force: true });
}
