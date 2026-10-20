/** A failed direct retry must retain possible-send suppression across runs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-direct-error-'));
Object.assign(process.env, { DATA_DIR: directory, DRY_RUN: 'true', COST_TRACKING: 'false',
  CELERIS_API_KEY: '' });
const { runDirectExternalApplication } = await import('./direct-external.js');
const { captureApplicationFailure } = await import('./application-diagnostics.js');
const { withApplicationModel } = await import('./application-model.js');
const { config } = await import('./config.js');
const { AppliedIndex } = await import('./store.js');
const { ApplicationReservations } = await import('./application-reservations.js');
const profile = { name: 'Alex Fixture', email: 'alex@example.test', phone: '', suburb: 'Sydney', state: 'NSW',
  nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
  experienceSummary: 'Fictional retail service experience.', skills: [], excludedDomains: [], securityClearance: '' };

test('direct application errors remember an uncertain send, but ordinary pre-send errors stay retryable', async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).hostname === 'direct.fixture.invalid'
    ? route.fulfill({ contentType: 'text/html', body: '<main><h1>Fictional retail assistant</h1><button>Apply now</button></main>' })
    : route.abort('blockedbyclient'));
  const page = await context.newPage();
  let uncertainCalls = 0, ordinaryCalls = 0;
  try {
    await assert.rejects(() => runDirectExternalApplication(page, 'https://example.com/job', profile, () => null, {
      runAgent: async () => { throw new Error('No override may execute on a real destination.'); },
    }), /isolated dry-run fixture/);
    const uncertain = { runAgent: async ({ page, job }: Parameters<typeof import('./agent/loop.js').runApplicationAgent>[0]) => {
      uncertainCalls++;
      const failure = new Error('Synthetic provider error after possible send');
      captureApplicationFailure(page, job.id, failure, { stage: 'agent-loop', submitPressed: true });
      throw failure;
    } };
    const uncertainUrl = 'https://direct.fixture.invalid/possible-send';
    await runDirectExternalApplication(page, uncertainUrl, profile, () => null, uncertain);
    const saved = JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].submittedByMyasis, false, 'Uncertainty must never become a claimed success.');
    assert.equal(saved[0].score, 0);
    await runDirectExternalApplication(page, uncertainUrl, profile, () => null, uncertain);
    assert.equal(uncertainCalls, 1, 'A subsequent run must not attempt the same uncertain application.');

    // Use a separate fictional role so its identity cannot match the held role.
    const ordinary = { runAgent: async () => { ordinaryCalls++; throw new Error('Synthetic pre-send error'); } };
    await context.unroute('**/*');
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Fictional laboratory assistant</h1><button>Apply now</button></main>' }));
    const ordinaryUrl = 'https://direct.fixture.invalid/before-send';
    await runDirectExternalApplication(page, ordinaryUrl, profile, () => null, ordinary);
    await runDirectExternalApplication(page, ordinaryUrl, profile, () => null, ordinary);
    assert.equal(ordinaryCalls, 2, 'Pre-send errors must not quarantine an application that was never sent.');
    assert.equal(JSON.parse(readFileSync(join(directory, 'applied.json'), 'utf8')).length, 1);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent-only direct orchestration treats duplicate history as advisory and does not reserve uncertain sends', async () => {
  const ownerDir = mkdtempSync(join(tmpdir(), 'owtomate-direct-agent-only-'));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Fictional receptionist</h1><button>Apply now</button></main>' }));
  const page = await context.newPage();
  const url = 'https://agent.fixture.invalid/application';
  const jobId = `external-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
  const oldExternal = config.allowExternalApply;
  config.allowExternalApply = true;
  let calls = 0;
  try {
    await withApplicationModel({ DATA_DIR: ownerDir, APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }, async () => {
      new AppliedIndex().add({ jobId, title: 'Fictional receptionist', company: 'agent.fixture.invalid', location: '', url,
        appliedAt: new Date().toISOString(), score: 0, platform: 'external', scoreReasons: ['Earlier uncertainty'], submittedByMyasis: false });
      const failureAgent = { runAgent: async ({ page, job }: Parameters<typeof import('./agent/loop.js').runApplicationAgent>[0]) => {
        calls++;
        const failure = new Error('Synthetic error after possible send');
        captureApplicationFailure(page, job.id, failure, { stage: 'agent-loop', submitPressed: true });
        throw failure;
      } };
      await runDirectExternalApplication(page, url, profile, () => null, failureAgent);
      await runDirectExternalApplication(page, url, profile, () => null, failureAgent);
      assert.equal(calls, 2, 'Only the applying agent may judge whether this advisory history permits retry.');
      assert.equal(new AppliedIndex().all.length, 1, 'Uncertainty alone must not add another history record.');
      assert.equal(existsSync(join(ownerDir, 'application-reservations.sqlite')), false, 'Agent-only must not acquire a journal claim.');

      // Even an old protected-mode claim may inform the agent but cannot veto its decisions.
      const journal = new ApplicationReservations(ownerDir);
      const claim = journal.acquire({ id: jobId, title: 'Fictional receptionist', company: 'agent.fixture.invalid', location: '', url, platform: 'external', applicationMode: 'external' });
      assert.ok(claim);
      journal.close();
      await runDirectExternalApplication(page, url, profile, () => null, failureAgent);
      assert.equal(calls, 3);
      const after = new ApplicationReservations(ownerDir);
      assert.equal(after.state(claim), 'running', 'Agent-only orchestration must not mutate protected reservations.');
      after.close();

      config.allowExternalApply = false;
      await runDirectExternalApplication(page, url, profile, () => null, failureAgent);
      assert.equal(calls, 3, 'Decision mode must not override employer-site entitlement.');
    });
  } finally {
    config.allowExternalApply = oldExternal;
    await browser.close();
    rmSync(ownerDir, { recursive: true, force: true });
  }
});
