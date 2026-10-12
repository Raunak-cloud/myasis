import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryCaptchaSolve } from './retry.js';

test('a failed challenge gets two further solves in the same session and stops on success', async () => {
  const results = ['solve_failed', 'solve_failed', 'solve_finished'];
  let calls = 0; let pauses = 0;
  const result = await retryCaptchaSolve({ solve: async () => ({ status: results[calls++] }), stillChallenged: async () => true, pause: async () => { pauses++; } });
  assert.deepEqual(result, { status: 'solved', attempts: 3 }); assert.equal(calls, 3); assert.equal(pauses, 2);
});

test('persistent failure stops at three, while an invalid or broken request stops immediately', async () => {
  for (const status of ['solve_failed', 'not_detected', 'invalid']) {
    let calls = 0;
    const result = await retryCaptchaSolve({ solve: async () => { calls++; return { status }; }, stillChallenged: async () => true, pause: async () => {} });
    assert.equal(result.status, 'failed'); assert.equal(calls, status === 'invalid' ? 1 : 3);
  }
  let calls = 0;
  const failed = await retryCaptchaSolve({ solve: async () => { calls++; throw new Error('private provider error'); }, stillChallenged: async () => true, pause: async () => {} });
  assert.deepEqual(failed, { status: 'failed', attempts: 1 }); assert.equal(calls, 1);
});

test('page changes and disappearing challenges stop retries without reloading or pressing Submit', async () => {
  let calls = 0;
  const result = await retryCaptchaSolve({ solve: async () => { calls++; return { status: 'not_detected' }; }, stillChallenged: async () => false, pause: async () => { throw new Error('No pause after page cleared'); } });
  assert.deepEqual(result, { status: 'cleared', attempts: 1 }); assert.equal(calls, 1);
});

test('timeouts never overlap solver requests and the total deadline cannot extend through retries', async () => {
  let calls = 0;
  const timeout = await retryCaptchaSolve({ solve: () => { calls++; return new Promise(() => {}); }, stillChallenged: async () => true, pause: async () => {} }, { attempts: 3, attemptMs: 15, totalMs: 30 });
  assert.deepEqual(timeout, { status: 'failed', attempts: 1 }); assert.equal(calls, 1);
  let time = 0;
  const budget = await retryCaptchaSolve({ solve: async () => ({ status: 'solve_failed' }), stillChallenged: async () => true, pause: async () => { time = 101; }, now: () => time }, { attempts: 3, attemptMs: 90, totalMs: 100 });
  assert.deepEqual(budget, { status: 'failed', attempts: 1 });
});
