import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import { createReadinessFixtureReply } from './readiness-fixture.js';
import type { CandidateProfile, JobListing } from '../types.js';

test('public employer forms and native boards can hand off exact vacancies', { timeout: 55_000 }, async t => {
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
    { id: '12345679', destination: 'https://jobs.lever.co/fixture/00000000-abcd-4321-aaaa-0123456789ab/apply', listedDestination: false },
    { id: '12345680', destination: 'https://hub24management.wd105.myworkdayjobs.com/en-US/Careers/job/Sydney/Fixture_JR1', listedDestination: true },
    { id: '12345681', destination: 'https://new-board.fixture.invalid/roles/123/apply', listedDestination: true },
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
      `<main><h1>Fixture Analyst application</h1>
      <form onsubmit="event.preventDefault(); this.hidden = true; document.querySelector('#receipt').hidden = false">
        <label for="candidate">Full name</label><input id="candidate" required>
        <button type="submit" id="submit">Submit application</button></form>
      <p id="receipt" hidden>Application received for Fixture Analyst.</p></main>` });
    return route.abort('blockedbyclient');
  });

  for (const { id, destination, listedDestination } of fixtures) {
    const job: JobListing = { id, title: 'Fixture Analyst', company: 'Fixture Employer',
      location: 'Sydney', platform: 'seek', url: `https://www.seek.com.au/job/${id}`,
      applicationUrl: listedDestination ? destination : undefined };
    let turn = 0;
    const reviewReply = createReadinessFixtureReply();
    const actions = [
      { name: 'browser_action', args: { action: 'click', selector: '#apply' } },
      { name: 'browser_action', args: { action: 'fill', selector: '#candidate', value: profile.name } },
      { name: 'browser_action', args: { action: 'click', selector: '#submit', sends_application: true } },
      { name: 'finish', args: { status: 'applied', evidence: 'Application received for Fixture Analyst.', reason: 'The employer fixture confirmed receipt.', receipt: { quote: 'Application received for Fixture Analyst.' } } },
    ];
    const model = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const review = reviewReply(JSON.parse(String(init?.body)));
      if (review) return review;
      const call = actions[turn++];
      assert.ok(call, 'Expected the agent to reach and fill the employer form');
      if (turn >= 2) assert.equal(page.url(), destination);
      if (turn === 3) assert.equal(await page.locator('#candidate').inputValue(), profile.name);
      if (turn === 4) assert.equal(await page.locator('#receipt').isVisible(), true);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: `handoff-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
        ] } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
    });
    try {
      const outcome = await applyToJobWithAgent(page, job, profile, { onFriction: () => {} });
      assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
      assert.equal(outcome.submitPressed, true);
      assert.equal(turn, actions.length);
    } finally {
      model.mock.restore();
    }
  }

  await t.test('an employer Apply click hands the vacancy back before the next tool can send', async () => {
    const { runApplicationAgent } = await import('./loop.js');
    for (const [target, destination] of [
      ['_self', 'https://www.seek.com.au/job/99887766'],
      ['_blank', 'https://au.indeed.com/viewjob?jk=0123456789abcdef'],
    ]) {
      const origin = `https://employer.fixture.invalid/jobs/${target}`;
      const fixture = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await fixture.route('**/*', route => {
          const url = route.request().url();
          if (url === origin) return route.fulfill({ contentType: 'text/html', body:
            `<main><h1>Fixture Analyst</h1><a id="apply" target="${target}" href="${destination}">Apply</a></main>` });
          if (url === destination) return route.fulfill({ contentType: 'text/html', body:
            '<main><h1>Fixture Analyst</h1><button id="submit" onclick="document.title=\'sent\'">Submit application</button></main>' });
          return route.abort();
        });
        const employer = await fixture.newPage();
        await employer.goto(origin);
        const job: JobListing = { id: `handoff-${target}`, platform:'external', title:'Fixture Analyst', company:'Fixture Employer', location:'Sydney', url:origin };
        let calls = 0;
        const model = t.mock.method(globalThis, 'fetch', async () => {
          assert.equal(++calls, 1, 'The employer agent must stop after observing the native posting');
          return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
            { id:'open', type:'function', function:{ name:'browser_action', arguments:JSON.stringify({action:'click',selector:'#apply'}) } },
            { id:'send', type:'function', function:{ name:'browser_action', arguments:JSON.stringify({action:'click',selector:'#submit',sends_application:true}) } },
          ] } }], usage:{prompt_tokens:50,completion_tokens:10} });
        });
        try {
          const run = await runApplicationAgent({ page:employer, job, profile, handoffNativePosting:true });
          assert.deepEqual(run.outcome, { status:'off-platform', redirectedTo:destination });
          assert.equal(run.submitPressed, false);
          assert.equal(calls, 1);
          const board = fixture.pages().find(tab => tab.url() === destination);
          assert.ok(board);
          assert.notEqual(await board.title(), 'sent');
        } finally { model.mock.restore(); }
      } finally { await fixture.close(); }
    }
  });
});
