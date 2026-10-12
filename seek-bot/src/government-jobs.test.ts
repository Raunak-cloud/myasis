import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './agent/tools.js';

// Every government page is a local browser fixture, and every model reply is mocked.
const directory = mkdtempSync(join(tmpdir(), 'government-jobs-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
process.env.SITE_AUTH_SECRET = 'fixture-secret';
process.env.DRY_RUN = 'true';
const { isForbiddenDestination, RunGuards } = await import('./agent/guards.js');
const { CostMeter } = await import('./agent/celeris.js');
const { observe } = await import('./agent/observe.js');
const { doClick, doCompleteAuthentication } = await import('./agent/tools.js');
const { runRawTool, watchTab } = await import('./agent/raw-tools.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: JSON.stringify({ sends_application: false }),
} }] }), { headers: { 'content-type': 'application/json' } });

for (const host of ['jobs.nsw.gov.au', 'careers.health.qld.gov.au', 'www.apsjobs.gov.au']) {
  assert.equal(isForbiddenDestination(`https://${host}/apply/1`), false);
  assert.equal(isForbiddenDestination(`https://${host}/login`), false);
  assert.equal(isForbiddenDestination(`https://${host}/checkout`), true);
}

const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  const html = '<main><h1>Government careers</h1><a href="https://careers.health.qld.gov.au/login">Open sign in</a>' +
    '<label>Email address <input type="email"></label><label>Password <input type="password"></label></main>';
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://jobs.nsw.gov.au/apply/1');
  const ctx: ToolContext = {
    page,
    profile: { name: 'Alex Smith', phone: '0400000000', email: 'alex@example.com', nationality: 'Australian',
      expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' },
    job: { id: 'fixture', title: 'Analyst', company: 'Agency', location: 'Sydney', url: page.url(), applicationMode: 'external' },
    observation: await observe(page), captured: [], actions: [], log: () => {},
    guards: new RunGuards({ maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 60_000, maxTotalMs: 600_000, meter: new CostMeter(1) }),
  };
  watchTab(page, ctx);

  const signIn = ctx.observation.actions.find((action) => action.text === 'Open sign in');
  assert.ok(signIn);
  assert.equal((await doClick(ctx, { ref: signIn.ref })).kind, 'ok');
  assert.equal(page.url(), 'https://careers.health.qld.gov.au/login', 'listed links can open government authentication');

  ctx.observation = await observe(page);
  assert.equal((await doCompleteAuthentication(ctx, {
    refs: ctx.observation.fields.map((field) => field.ref), purpose: 'sign_in',
  })).kind, 'ok');
  assert.equal(await page.locator('input[type=email]').inputValue(), ctx.profile.email);
  assert.ok(await page.locator('input[type=password]').inputValue(), 'government sites use the same employer authentication path');

  assert.equal((await runRawTool(ctx, 'navigate_page', { url: 'https://www.apsjobs.gov.au/apply/2' }))?.kind, 'ok');
  assert.equal(page.url(), 'https://www.apsjobs.gov.au/apply/2', 'general browser navigation permits government jobs');

  const malformed = await runRawTool(ctx, 'navigate_page', { url: 'https://www.apsjobs.gov.au/%invalid' });
  assert.equal(malformed?.kind, 'ok');
  assert.match(JSON.stringify(malformed), /invalid URL encoding/);
  assert.equal(page.url(), 'https://www.apsjobs.gov.au/apply/2');

  assert.equal((await runRawTool(ctx, 'navigate_page', { url: 'https://www.apsjobs.gov.au/?email=alex%40example.com' }))?.kind, 'ok');
  assert.equal(page.url(), 'https://www.apsjobs.gov.au/apply/2', 'candidate email cannot be leaked in a navigation URL');
  console.log('PASS: government links, authentication and browser navigation work; payment and candidate-data guards remain enforced');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
