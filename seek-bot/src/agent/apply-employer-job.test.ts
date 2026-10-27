import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-smartrecruiters-fixture-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.ALLOW_EXTERNAL_APPLY = 'true';
process.env.SMARTRECRUITERS_ADMIN_ENABLED = 'true';
process.env.DRY_RUN = 'false';
process.env.APPLY_ONLY = 'all';
const { applyToEmployerJob } = await import('./apply-employer-job.js');
const { smartRecruitersListing } = await import('../smartrecruiters.js');
const { config } = await import('../config.js');
const { reviewContentFingerprint, reviewContextFingerprint, currentFitReview } = await import('../review-cache.js');
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
    const target = { ...job, id: `${source.platform}-fixture`, platform: source.platform, url: source.url, applicationUrl: source.url,
      description: 'Build web applications.', fitReview: undefined as import('../types.js').JobFitReview | undefined };
    target.fitReview = { score: 100, reason: 'Development role approved.', evidence: ['Build web applications.'],
      contentFingerprint: reviewContentFingerprint(target)!, contextFingerprint: reviewContextFingerprint(profile) };
    let refreshed = false;
    const outcome = await applyToEmployerJob(page, target, profile, deps, { guard, refresh: async previous => {
      refreshed = true; return { ...previous, fitReview: undefined };
    }, runAgent: async options => {
      assert.equal(options.job.platform, source.platform);
      assert.equal(refreshed, true);
      assert.ok(currentFitReview(options.job, profile), 'provider refresh must preserve the matcher approval into the real application boundary');
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
  await context.addCookies([{ name: 'account-session', value: 'fixture-private', url: job.url }]);
  await applyToEmployerJob(page, job, profile, deps, { guard, runAgent: async options => {
    assert.equal(options.page, page, 'employer feeds use the existing native page');
    assert.equal(options.page.context(), context, 'the account browser context remains unchanged');
    assert.equal((await context.cookies())[0]?.value, 'fixture-private');
    return { outcome: { status: 'needs-human', reason: 'Fixture only' }, captured: [], actions: [], submitPressed: false, steps: 1, usage: 'no employer transmission' };
  } });
  await assert.rejects(applyToEmployerJob(page, job, profile, deps, { guard: async () => { throw new Error('Fixture guard setup failed'); } }), /Fixture guard setup failed/);
  await assert.rejects(applyToEmployerJob(page, job, profile, deps, { guard, runAgent: async () => { throw new Error('Fixture native session failed'); } }), /Fixture native session failed/);
  const reports = readFileSync(join(directory, 'traces', `${job.id}.failures.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const failure = reports.find(report => report.error.message === 'Fixture native session failed');
  assert.equal(failure.pageClosed, false, 'failure cleanup preserves the account browser');
  assert.equal(failure.browserConnected, true);
  assert.equal(failure.stage, 'employer-application');
  assert.equal(page.isClosed(), false);
  assert.equal((await context.cookies())[0]?.value, 'fixture-private');
  console.log('PASS: admin, external scope and dry-run gates; public-feed handoff to application agent; local form only; guard cleanup');
} finally {
  await browser?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('owtomate-smartrecruiters-fixture-'));
  rmSync(directory, { recursive: true, force: true });
}
