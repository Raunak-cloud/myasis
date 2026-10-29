import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-no-step-limit-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false',
  APPLICATION_REVIEW_MODE: '', APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'false',
  CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0',
  FORM_CORPUS_DIR: join(directory, 'corpus'), ALLOW_EXTERNAL_APPLY: 'true', DRY_RUN: 'false' });
const { runAgentOnlyApplication } = await import('./agent-only.js');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  assert.ok(calls <= 122, 'The scripted agent must finish itself.');
  const tool = calls === 122 ? { name: 'finish', arguments: { status: 'skipped', reason: 'Fixture finished after both former turn ceilings.', evidence: 'No real application was attempted.' } }
    : { name: 'save_progress', arguments: { note: `Read-only inspection ${calls}.` } };
  return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `step-${calls}`, type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
};
try {
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: '<main><h1>Fixture application</h1><label>Name<input value="Fixture"></label></main>' }) : route.abort());
  await page.goto('https://steps.fixture.invalid/application');
  const run = await runAgentOnlyApplication({ page,
    job: { id: 'no-step-limit', title: 'Fixture', company: 'Fixture', location: 'Sydney', url: page.url() },
    profile: { name: 'Fixture', email: 'fixture@example.invalid', skills: [], excludedDomains: [] } as never, log: () => {} });
  assert.equal(calls, 122); assert.equal(run.steps, 122);
  assert.equal(run.outcome.status, 'skipped');
  assert.ok('reason' in run.outcome && run.outcome.reason === 'Fixture finished after both former turn ceilings.');
  assert.equal(run.submitPressed, false);
  console.log('PASS: the real agent loop completes 122 turns without form progress or a step cutoff; provider calls are mocked.');
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  closeCelerisQueues();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-no-step-limit-'));
  rmSync(directory, { recursive: true, force: true });
}
