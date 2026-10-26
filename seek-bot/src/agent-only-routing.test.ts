import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-agent-routing-'));
Object.assign(process.env, { DATA_DIR: directory, DRY_RUN: 'true', REHEARSE: 'true', COST_TRACKING: 'false',
  INDEED_BASE: 'https://indeed.fixture.invalid', ALLOW_EXTERNAL_APPLY: 'true', CELERIS_API_KEY: 'synthetic-key' });
const { applyToIndeedJob } = await import('./apply-indeed.js');
const { applyToJobWithAgent } = await import('./agent/apply-agent.js');
const { withApplicationModel } = await import('./application-model.js');
const { config } = await import('./config.js');
const profile = { name: 'Alex Fixture', email: 'alex@example.test', phone: '', suburb: 'Sydney', state: 'NSW',
  nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
  experienceSummary: 'Fictional retail service experience.', skills: [], excludedDomains: [], securityClearance: '' };

test('SEEK and Indeed hand listing problems to the same applying agent before legacy prechecks', async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let html = '<main><h1>Fictional vacancy</h1><p>You already applied. Checking your browser: security verification.</p></main>';
  await context.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.invalid')
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort('blockedbyclient'));
  const originalFetch = globalThis.fetch;
  const oldExternal = config.allowExternalApply;
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    assert.ok(names.includes('browser_action'));
    assert.ok(!names.includes('answer_questions'));
    assert.match(JSON.stringify(body.messages), /sole applying agent/);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: `call-${modelCalls}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'skipped', reason: 'Synthetic agent assessed the listing.', evidence: 'Observed the listing text directly.' }) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 30 } });
  };
  try {
    await withApplicationModel({ DATA_DIR: directory, CELERIS_API_KEY: 'synthetic-key', APPLICATION_AI_MODEL: 'celeris',
 }, async () => {
      const page = await context.newPage();
      for (const [platform, apply] of [['seek', applyToJobWithAgent], ['indeed', applyToIndeedJob]] as const) {
        const outcome = await apply(page, { id: `fixture-${platform}`, title: 'Fictional vacancy', company: 'Fixture employer', location: '',
          url: `https://${platform}.fixture.invalid/listing`, platform, applicationMode: 'unknown', alreadyApplied: true }, profile, {
          onFriction: () => { throw new Error('A legacy wall classifier must not run before agent handoff.'); },
        });
        assert.equal(outcome.status, 'rehearsed', 'Dry run remains authoritative even when the model reports a terminal judgement.');
      }
      assert.equal(modelCalls, 2, 'One applying agent per listing; no page judge, receipt verifier or duplicate classifier.');

      config.allowExternalApply = false;
      html = '<main><h1>Fictional vacancy</h1><a data-automation="job-detail-apply" href="https://employer.fixture.invalid/apply">Apply</a><a href="https://employer.fixture.invalid/apply">Apply on company site</a></main>';
      for (const [platform, apply] of [['seek', applyToJobWithAgent], ['indeed', applyToIndeedJob]] as const) {
        const outcome = await apply(page, { id: `external-${platform}`, title: 'Fictional vacancy', company: 'Fixture employer', location: '',
          url: `https://${platform}.fixture.invalid/listing`, platform, applicationMode: 'unknown' }, profile, { onFriction: () => {} });
        assert.equal(outcome.status, 'off-platform', 'Agent-only must retain employer-site access restrictions.');
      }
      assert.equal(modelCalls, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.allowExternalApply = oldExternal;
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
