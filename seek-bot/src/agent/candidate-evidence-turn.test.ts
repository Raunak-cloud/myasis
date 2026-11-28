import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import { applicationAgentIdentity, withApplicationModel } from '../application-model.js';
import { fixtureToolArguments, isSpecialistFixtureRequest } from './specialist-fixture.js';

type FixtureRequest = {
  model: string;
  tools: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
};
type FixtureCall = { name: string; args: Record<string, unknown> };

test('candidate evidence focuses the next decision without interrupting ordinary unscoped batches', { timeout: 45_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-evidence-turn-'));
  const originalEnvironment = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    DATA_DIR: directory,
    ALLOW_EXTERNAL_APPLY: 'true',
    DRY_RUN: 'true',
    APPLICATION_REVIEW_MODE: '',
    APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
    OPENROUTER_API_KEY: 'fixture-only',
    CELERIS_API_KEY: 'fixture-only',
    CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'),
    CELERIS_MIN_INTERVAL_MS: '0',
    COST_TRACKING: 'false',
  });
  writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([
    { id: 'start-date', label: 'Availability note', kind: 'note', enabled: true, text: 'Earliest start: Two weeks after accepting an offer.' },
    { id: 'citizenship', label: 'Citizenship note', kind: 'note', enabled: true, text: 'Citizenship: New Zealand citizen.' },
  ]));
  const { runAgentOnlyApplication } = await import('./agent-only.js');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const missing = { known: false, model: 'minimax', question: 'Date of birth', selector: '#month', html: `
        <fieldset aria-required="true"><legend>Date of birth</legend>
          <label>Month<input id="month" required></label>
          <label>Day<input id="day" required></label>
          <label>Year<input id="year" required></label>
        </fieldset>` } as const;
    const scenarios = [
      { ...missing, id: 'anchored-missing-question', plan: 'anchored-batch' },
      { ...missing, id: 'unanchored-sole-lookup', plan: 'single' },
      { ...missing, id: 'unanchored-evidence-batch', plan: 'evidence-batch', html: `${missing.html}
        <label>Citizenship<input name="citizenship" required></label>` },
      { ...missing, id: 'unanchored-ordinary-batch', plan: 'ordinary-batch' },
      { id: 'availability-known', plan: 'anchored-batch', known: true, model: 'celeris', question: 'Earliest start', selector: '#available', html: `
        <label>Earliest start<input id="available" required></label>` },
    ] as const;
    for (const scenario of scenarios) await t.test(scenario.id, async () => {
      const page = await browser.newPage();
      try {
        const ordinaryBatch = scenario.plan === 'ordinary-batch';
        const finish = (evidence: string): FixtureCall => ({
          name: 'finish', args: { status: 'skipped', reason: 'The fixture is complete.', evidence },
        });
        const url = `https://${scenario.id}.fixture.invalid/apply`;
        const job = { id: scenario.id, title: 'Fixture role', company: 'Fixture employer', location: 'Sydney', platform: 'workday' as const, url };
        await page.route('**/*', route => route.request().url() === url
          ? route.fulfill({ contentType: 'text/html', body: `<main><h1>Fixture role</h1>
            <label>Existing answer<input id="kept" value="Preserve this"></label>${scenario.html}
            <button id="planned" type="button" onclick="document.body.dataset.clicked='yes'">Next section</button>
            </main>` })
          : route.abort());
        await page.goto(url);
        const environment = { ...process.env, APPLICATION_AI_MODEL: scenario.model };
        let turn = 0;
        globalThis.fetch = async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as FixtureRequest;
          const offered = request.tools.map(tool => tool.function.name);
          assert.equal(request.model, applicationAgentIdentity(environment).model);
          assert.ok(!isSpecialistFixtureRequest(request));
          const fieldRef = await page.locator(scenario.selector).getAttribute('data-field-id');
          assert.match(fieldRef ?? '', /^f\d+$/);
          assert.ok(++turn <= (scenario.known ? 3 : 2), 'the same applying agent gets the next ordinary decision');
          let calls: FixtureCall[];
          if (turn === 1) {
            assert.ok(offered.includes('browser_navigate'));
            calls = [
              { name: 'read_candidate_evidence', args: { query: scenario.question, ...(scenario.plan === 'anchored-batch' ? { field_ref: fieldRef } : {}) } },
            ];
            if (scenario.plan === 'anchored-batch') {
              const clickRef = await page.locator('#planned').getAttribute('data-ref-id');
              assert.match(clickRef ?? '', /^a\d+$/);
              calls.push({ name: 'browser_click', args: { ref: clickRef } });
            } else if (scenario.plan === 'evidence-batch') {
              calls.push({ name: 'read_candidate_evidence', args: { query: 'citizenship' } });
            } else if (ordinaryBatch) {
              const ref = await page.locator('#kept').getAttribute('data-field-id');
              assert.match(ref ?? '', /^f\d+$/);
              calls.push({ name: 'browser_action', args: { action: 'fill', ref, value: 'Legacy batch completed' } });
            }
          } else if (ordinaryBatch) {
            assert.equal(await page.locator('#kept').inputValue(), 'Legacy batch completed');
            assert.ok(offered.includes('browser_navigate'), 'an ordinary unscoped batch does not focus the next decision');
            calls = [finish('The ordinary batch completed.')];
          } else if (turn === 2) {
            assert.equal(await page.locator('body').getAttribute('data-clicked'), null, 'a click scripted before the lookup result never executes');
            const context = request.messages.map(message => JSON.stringify(message.content)).join('\n');
            assert.ok(context.includes(scenario.question));
            assert.ok(context.includes('EVIDENCE PASSAGES'), 'the next decision sees the actual lookup result');
            assert.ok(context.includes(fieldRef!), 'the decision sees a current field reference');
            for (const tool of ['finish', 'read_candidate_evidence', 'save_progress', 'browser_fill', 'browser_select_dropdown', 'browser_click', 'browser_press_key']) {
              assert.ok(offered.includes(tool), `${tool} remains available for the focused decision`);
            }
            assert.ok(!offered.includes('browser_navigate'));
            assert.ok(!offered.includes('browser_run_script'));
            assert.ok(!offered.includes('browser_action'));
            if (scenario.plan === 'evidence-batch') {
              const focusedMessage = request.messages.find(message => typeof message.content === 'string'
                && message.content.startsWith('CANDIDATE QUESTION DECISION.'))?.content;
              assert.equal(typeof focusedMessage, 'string');
              assert.match(String(focusedMessage), /"query":"Date of birth","offset":0\}\nOWNER-SCOPED CANDIDATE EVIDENCE\./,
                'the complete birth date lookup result survives alongside the other lookup');
              assert.match(String(focusedMessage), /"query":"citizenship","offset":0\}\nOWNER-SCOPED CANDIDATE EVIDENCE\.[\s\S]*Citizenship: New Zealand citizen\./,
                'the second lookup also ran and its exact result survives');
            }
            if (scenario.known) {
              assert.ok(context.includes('Two weeks after accepting an offer.'));
              calls = [{ name: 'browser_fill', args: { ref: fieldRef, value: 'Two weeks after accepting an offer.' } }];
            } else {
              calls = [{ name: 'finish', args: {
                status: 'needs-human', reason: 'The candidate’s exact date of birth is required.',
                evidence: 'Date of birth is required on the form and unavailable in the candidate record.',
                questions: [{ field_ref: fieldRef }],
              } }];
            }
          } else {
            assert.equal(await page.locator(scenario.selector).inputValue(), 'Two weeks after accepting an offer.');
            assert.ok(offered.includes('browser_navigate'), 'ordinary tools return after the focused decision');
            calls = [finish('The known answer was filled.')];
          }
          return Response.json({ usage: { prompt_tokens: 50, completion_tokens: 10 }, choices: [{ message: {
            role: 'assistant', content: null,
            tool_calls: calls.map(({ name, args }, index) => ({ id: `${scenario.id}-${turn}-${index}`, type: 'function',
              function: { name, arguments: fixtureToolArguments(request, name, args) } })),
          } }] });
        };
        const run = await withApplicationModel(environment, () => runAgentOnlyApplication({
          simulation: 'isolated-form', page, job,
          profile: { name: 'Fixture Candidate', email: 'candidate@fixture.invalid', skills: [] } as never,
          log: () => {},
        }));
        const stoppedAt = ordinaryBatch ? 'Agent judgement: skipped. The ordinary batch completed.'
          : scenario.known ? 'Agent judgement: skipped. The known answer was filled.'
            : 'Agent judgement: needs-human. Date of birth is required on the form and unavailable in the candidate record.';
        assert.deepEqual(run.outcome, { status: 'rehearsed', stoppedAt });
        assert.equal(turn, scenario.known ? 3 : 2);
        assert.equal(run.submitPressed, false);
        assert.equal(await page.locator('#kept').inputValue(), ordinaryBatch ? 'Legacy batch completed' : 'Preserve this');
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
        if (!scenario.known) {
          assert.deepEqual(await page.locator('#month, #day, #year').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), ['', '', '']);
        }
      } finally {
        globalThis.fetch = originalFetch;
        await page.context().close();
      }
    });
  } finally {
    await browser.close();
    closeCelerisQueues();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(directory, { recursive: true, force: true });
  }
});
