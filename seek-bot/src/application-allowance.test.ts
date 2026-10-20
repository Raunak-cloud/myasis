import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationAllowance, withApplicationAllowance } from './application-allowance.js';
import { ApplicationSlots } from './application-workers.js';

test('quota scope permits corrected retries, counts only the caller-reported successful outcome and keeps run limits', async () => {
  const slots = new ApplicationSlots({ run: 1, day: 1, external: 1, appliedToday: () => 0, externalToday: 0 });
  const first = await slots.acquire(false);
  assert.ok(first);
  await withApplicationAllowance(first.beforeSubmit, async () => {
    assert.equal(await applicationAllowance(false), true);
    assert.equal(await applicationAllowance(false), true, 'A rejected submit may be corrected without a reservation veto.');
  });
  first.finish(false);
  const corrected = await slots.acquire(false);
  assert.ok(corrected, 'Unconfirmed/model-failed outcomes do not consume agent-only success allowance.');
  assert.equal(await withApplicationAllowance(corrected.beforeSubmit, () => applicationAllowance(false)), true);
  corrected.finish(true);
  assert.equal(await slots.acquire(false), null, 'A completed application still consumes the shared run/day limit.');
});

test('a previously unknown employer redirect respects external quota without applying reservation rules', async () => {
  const slots = new ApplicationSlots({ run: 2, day: 2, external: 1, appliedToday: () => 0, externalToday: 0 });
  const employer = await slots.acquire(false);
  const hosted = await slots.acquire(false);
  assert.ok(employer && hosted);
  await withApplicationAllowance(employer.beforeSubmit, async () => {
    assert.equal(await applicationAllowance(true), true);
    assert.equal(await applicationAllowance(true), true, 'Repeated checks do not reserve quota twice.');
  });
  await withApplicationAllowance(hosted.beforeSubmit, async () => {
    assert.equal(await applicationAllowance(true), false, 'An unexpected external redirect cannot exceed quota.');
    assert.equal(await applicationAllowance(false), true, 'Hosted capacity remains usable.');
  });
  employer.finish(false);
  assert.equal(await withApplicationAllowance(hosted.beforeSubmit, () => applicationAllowance(true)), true);
  hosted.finish(false);
});

test('quota scopes remain isolated across overlapping agents', async () => {
  const decisions = await Promise.all([true, false].map(allowed => withApplicationAllowance(() => allowed, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return applicationAllowance(true);
  })));
  assert.deepEqual(decisions, [true, false]);
});
