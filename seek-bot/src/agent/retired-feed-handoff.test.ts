import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import type { CandidateProfile, JobListing } from '../types.js';

test('SEEK can hand off to employer forms on PageUp and SmartRecruiters', { timeout: 40_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'seek-employer-handoff-'));
  t.after(() => {
    closeCelerisQueues();
    rmSync(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'),
    CELERIS_MIN_INTERVAL_MS: '0', APPLICATION_AI_MODEL: 'celeris', APPLICATION_REVIEW_MODE: 'auto',
    ALLOW_EXTERNAL_APPLY: 'true', APPLY_ONLY: 'all', DRY_RUN: 'false', COST_TRACKING: 'false',
  });
  const { applyToJobWithAgent } = await import('./apply-agent.js');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const fixtures = [
    { id: '96094553', destination: 'https://secure.dc2.pageuppeople.com/apply/fixture-one', listedDestination: false },
    { id: '96077084', destination: 'https://secure.dc2.pageuppeople.com/apply/fixture-two', listedDestination: true },
    { id: '12345678', destination: 'https://jobs.smartrecruiters.com/Fixture/1234', listedDestination: true },
  ];
  const profile = { name: 'Alex Fixture', email: 'alex@example.test', phone: '', suburb: 'Sydney', state: 'NSW',
    nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
    experienceSummary: 'Fictional analysis experience.', skills: [], excludedDomains: [], securityClearance: '' } satisfies CandidateProfile;

  await context.route('**/*', route => {
    const url = route.request().url();
    const listing = fixtures.find(fixture => url === `https://www.seek.com.au/job/${fixture.id}`);
    if (listing) return route.fulfill({ contentType: 'text/html', body:
      `<main><h1>Fixture Analyst at Fixture Employer</h1><a id="apply" data-automation="job-detail-apply" href="${listing.destination}">Apply on company site</a></main>` });
    if (fixtures.some(fixture => url === fixture.destination)) return route.fulfill({ contentType: 'text/html', body:
      '<main><h1>Fixture Analyst application</h1><form><label for="candidate">Full name</label><input id="candidate"></form></main>' });
    return route.abort('blockedbyclient');
  });

  for (const { id, destination, listedDestination } of fixtures) {
    const job: JobListing = { id, title: 'Fixture Analyst', company: 'Fixture Employer',
      location: 'Sydney', platform: 'seek', url: `https://www.seek.com.au/job/${id}`,
      applicationUrl: listedDestination ? destination : undefined };
    let turn = 0;
    const actions = [
      { name: 'browser_action', args: { action: 'click', selector: '#apply' } },
      { name: 'browser_action', args: { action: 'fill', selector: '#candidate', value: profile.name } },
      { name: 'finish', args: { status: 'skipped', reason: 'Fixture finished before submission', evidence: 'Employer form accepted the candidate name.' } },
    ];
    const model = t.mock.method(globalThis, 'fetch', async () => {
      const call = actions[turn++];
      assert.ok(call, 'Expected the agent to reach and fill the employer form');
      if (turn >= 2) assert.equal(page.url(), destination);
      if (turn === 3) assert.equal(await page.locator('#candidate').inputValue(), profile.name);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: `handoff-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
        ] } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
    });
    try {
      const outcome = await applyToJobWithAgent(page, job, profile, { onFriction: () => {} });
      assert.equal(outcome.status, 'skipped');
      assert.equal(outcome.reason, 'Fixture finished before submission');
      assert.equal(outcome.submitPressed, undefined);
      assert.equal(turn, actions.length);
    } finally {
      model.mock.restore();
    }
  }
});
