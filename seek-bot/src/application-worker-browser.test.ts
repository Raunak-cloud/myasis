import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './agent/tools/context.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-worker-browser-'));
Object.assign(process.env, { DATA_DIR: directory, DRY_RUN: 'false', ALLOW_EXTERNAL_APPLY: 'true', CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ problems: [] }) } }] }), { status: 200 })) as typeof fetch;
const { applicationWorkerContexts, showLiveActivity, workingIn } = await import('./browser.js');
const { readLiveTarget } = await import('./live-workers.js');
const { withApplicationWorker } = await import('./application-workers.js');
const { ApplicationReservations, withApplicationAttempt } = await import('./application-reservations.js');
const { observe } = await import('./agent/observe.js');
const { gateAdvance } = await import('./agent/tools/gate.js');
const { RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');

test('isolated sessions preserve login, separate mutable state/popups, and allow exactly one send of the same form', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const journal = new ApplicationReservations(directory);
  try {
    const seed = await browser.newContext({ viewport: null });
    await seed.addCookies([{ name: 'fixture_login', value: 'owner-session', domain: 'employer.fixture.invalid', path: '/' }]);
    await seed.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' }));
    const seedPage = await seed.newPage();
    await seedPage.goto('https://employer.fixture.invalid/seed');
    await seedPage.evaluate(() => localStorage.setItem('candidate', 'Fictional Owner'));
    const [seek, indeed] = await applicationWorkerContexts(seed, 2);
    const markup = '<main><h1>Fixture Assistant</h1><label>First name<input value="Fixture"></label><button id="submit" type="button" onclick="document.title=\'SENT\'">Submit application</button></main>';
    let reads = 0, maximumReads = 0;
    for (const context of [seek, indeed]) await context.route('**/*', async route => {
      maximumReads = Math.max(maximumReads, ++reads);
      try {
        await new Promise(resolve => setTimeout(resolve, 60));
        await route.fulfill({ contentType: 'text/html', body: markup });
      } finally { reads--; }
    });
    const pages = await Promise.all([seek.newPage(), indeed.newPage()]);
    await Promise.all(pages.map(page => page.goto('https://employer.fixture.invalid/jobs/7/apply')));
    assert.equal(maximumReads, 2, 'isolated worker pages can load listings concurrently');
    await Promise.all([
      withApplicationWorker('seek', () => showLiveActivity({ phase: 'reviewing' }, pages[0])),
      withApplicationWorker('indeed', () => showLiveActivity({ phase: 'reviewing' }, pages[1])),
    ]);
    const reviewTarget = readLiveTarget(directory, 'seek')!;
    const otherReviewTarget = readLiveTarget(directory, 'indeed')!;
    assert.equal(otherReviewTarget.activity?.phase, 'reviewing');
    assert.notEqual(reviewTarget.targetId, otherReviewTarget.targetId);
    await withApplicationWorker('indeed', () => showLiveActivity({ phase: 'applying', detail: 'Fixture application' }, pages[1]));
    const applicationTarget = readLiveTarget(directory, 'indeed')!;
    assert.equal(reviewTarget.activity?.phase, 'reviewing');
    assert.equal(applicationTarget.activity?.phase, 'applying');
    assert.notEqual(reviewTarget.targetId, applicationTarget.targetId);
    await withApplicationWorker('seek', () => showLiveActivity({ phase: 'waiting', detail: 'Review page released' }));
    assert.equal(readLiveTarget(directory, 'seek')?.targetId, undefined);
    assert.deepEqual(readLiveTarget(directory, 'indeed'), applicationTarget);
    await withApplicationWorker('indeed', () => workingIn(pages[1]));
    assert.equal(readLiveTarget(directory, 'indeed')?.activity?.phase, 'applying');
    assert.equal(await pages[0].evaluate(() => localStorage.getItem('candidate')), 'Fictional Owner');
    assert.equal((await indeed.cookies())[0].value, 'owner-session');
    await seek.addCookies([{ name: 'fixture_login', value: 'changed-in-seek', domain: 'employer.fixture.invalid', path: '/' }]);
    await pages[0].evaluate(() => localStorage.setItem('candidate', 'Changed in one worker'));
    assert.equal((await indeed.cookies())[0].value, 'owner-session');
    assert.equal(await pages[1].evaluate(() => localStorage.getItem('candidate')), 'Fictional Owner');

    const profile = { name: 'Fixture', email: 'fixture@example.test', phone: '', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
    const jobs = (['seek', 'indeed'] as const).map(platform => ({ id: 'same-id', platform, title: 'Assistant', company: 'Fixture', location: 'Sydney', url: `https://${platform}.fixture.invalid/jobs/7` }));
    const contexts: ToolContext[] = await Promise.all(pages.map(async (page, index) => ({ page, job: jobs[index], profile,
      observation: await observe(page), captured: [], actions: [], resumeSettled: true,
      guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60000, maxTotalMs: 600000, meter: new CostMeter(1) }), log: () => {} })));
    const ids = jobs.map(job => journal.acquire(job)!);
    assert.ok(ids.every(Boolean));
    const decisions = await Promise.all(contexts.map((ctx, index) => withApplicationAttempt({ journal, id: ids[index], job: jobs[index] }, () => gateAdvance(ctx, 'Submit application', undefined, { knownSubmit: true }))));
    assert.equal(decisions.filter(decision => decision.proceed).length, 1);
    for (let i = 0; i < decisions.length; i++) if (decisions[i].proceed) await pages[i].locator('#submit').click();
    assert.equal((await Promise.all(pages.map(page => page.title()))).filter(title => title === 'SENT').length, 1);

    const [popupA, popupB] = await Promise.all(pages.map(async page => {
      const popup = page.waitForEvent('popup');
      await page.evaluate(() => { window.open('/jobs/7/next'); });
      return popup;
    }));
    assert.equal(popupA.context(), seek); assert.equal(popupB.context(), indeed);
    await seek.close();
    assert.equal(pages[1].isClosed(), false); assert.equal(popupB.isClosed(), false);
    assert.equal(seedPage.isClosed(), false);
    await indeed.close();
  } finally { journal.close(); await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});
