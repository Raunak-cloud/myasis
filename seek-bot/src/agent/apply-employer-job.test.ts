import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
const job = smartRecruitersListing({
  id: '123456789', name: 'Fixture Developer', company: { identifier: 'FixtureEmployer', name: 'Fixture Employer' },
  location: { city: 'Sydney', country: 'au' }, visibility: 'PUBLIC',
}, 'FixtureEmployer')!;
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
    if (route.request().url() !== job.url) return route.abort();
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
  console.log('PASS: admin, external scope and dry-run gates; public-feed handoff to application agent; local form only; guard cleanup');
} finally {
  await browser?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('owtomate-smartrecruiters-fixture-'));
  rmSync(directory, { recursive: true, force: true });
}
