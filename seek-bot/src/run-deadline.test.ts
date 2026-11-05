import assert from 'node:assert/strict';
import test from 'node:test';
import { RunDeadline } from './run-deadline.js';
import { nextApplicationCandidate } from './application-workers.js';

test('absolute deadline closes admission even before its timer or IPC is delivered', async () => {
  let now = 99;
  const deadline = new RunDeadline(100, () => now);
  let claims = 0;
  assert.equal(await nextApplicationCandidate(() => ++claims, () => true, async () => false, () => deadline.reached), 1);
  now = 100;
  assert.equal(await nextApplicationCandidate(() => ++claims, () => true, async () => false, () => deadline.reached), undefined);
  assert.equal(claims, 1);
});

test('deadline during an outstanding review cannot admit its newly qualified application', async () => {
  const deadline = new RunDeadline(NaN);
  let available = false, taken = false;
  const result = await nextApplicationCandidate(() => {
    if (available) { taken = true; return 'later job'; }
  }, () => false, async () => { deadline.request(); available = true; return true; }, () => deadline.reached);
  assert.equal(result, undefined); assert.equal(taken, false);
});

test('draining wakes idle workers and cooldowns once without cancelling active application work', () => {
  const deadline = new RunDeadline(NaN);
  let wakeups = 0;
  deadline.onReached(() => wakeups++);
  deadline.request(); deadline.request();
  assert.equal(wakeups, 1);
  deadline.onReached(() => wakeups++);
  assert.equal(wakeups, 2, 'a late waiter must not miss the deadline');
  assert.equal(deadline.reached, true);
});
