/** The sole application agent owns retry decisions; history is advisory. */
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

test('agent-only direct orchestration treats duplicate history as advisory and does not reserve uncertain sends', async () => {
  const ownerDir = mkdtempSync(join(tmpdir(), 'owtomate-direct-agent-only-'));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1 hidden>Unsupported browser</h1><main><h1>Fictional receptionist</h1><button>Apply now</button></main>' }));
  const page = await context.newPage();
  const url = 'https://agent.fixture.invalid/application';
  const jobId = `external-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
  const oldExternal = config.allowExternalApply;
  config.allowExternalApply = true;
  let calls = 0;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(' '));
  try {
    await withApplicationModel({ DATA_DIR: ownerDir }, async () => {
      new AppliedIndex().add({ jobId, title: 'Fictional receptionist', company: 'agent.fixture.invalid', location: '', url,
        appliedAt: new Date().toISOString(), score: 0, platform: 'external', scoreReasons: ['Earlier uncertainty'], submittedByMyasis: false });
      const failureAgent = { runAgent: async ({ page, job }: Parameters<typeof import('./agent/loop.js').runApplicationAgent>[0]) => {
        calls++;
        assert.equal(job.title, 'Fictional receptionist', 'hidden browser warnings cannot become the job identity');
        assert.equal(job.source, 'chosen', 'an explicit direct application carries the user selection through to the sole applying agent');
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
      assert.equal(output.filter(line => line.includes('Submission not confirmed:')).length, 3,
        'possible sends must not be reported as ordinary failed or skipped applications');
      const after = new ApplicationReservations(ownerDir);
      assert.equal(after.state(claim), 'running', 'Agent-only orchestration must not mutate protected reservations.');
      after.close();

      const questions = [{ question: 'Current clearance', kind: 'select' as const, options: ['None', 'Baseline'] }];
      await runDirectExternalApplication(page, url, profile, () => null, {
        runAgent: async ({ log }) => {
          log?.('Agent judgement: needs-human: Current clearance is unknown.');
          return { outcome: { status: 'needs-human', reason: 'Which clearance do you currently hold?', questions },
            captured: [], actions: [], submitPressed: false, steps: 1, usage: 'offline fixture' };
        },
      });
      assert.ok(output.some(line => line.includes('⏸ needs your answer: Which clearance')),
        'direct employer applications use the same actionable question marker as board runs');
      const saved = JSON.parse(readFileSync(join(ownerDir, 'run-log.jsonl'), 'utf8').trim().split('\n').at(-1)!);
      assert.equal(saved.status, 'needs-human');
      assert.deepEqual(saved.questions, questions);

      config.allowExternalApply = false;
      await runDirectExternalApplication(page, url, profile, () => null, failureAgent);
      assert.equal(calls, 3, 'Decision mode must not override employer-site entitlement.');
    });
  } finally {
    console.log = originalLog;
    config.allowExternalApply = oldExternal;
    await browser.close();
    rmSync(ownerDir, { recursive: true, force: true });
  }
});
