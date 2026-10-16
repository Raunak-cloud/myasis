/** Offline budget semantics: no browser, model, credential or paid calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunGuards, type RunGuardOptions } from './guards.js';
import { CostMeter } from './celeris.js';

const limits = { maxSteps: 30, maxStepsPerPage: 16, maxStuckMs: 180_000, maxTotalMs: 600_000 };
function guard(options: Partial<RunGuardOptions> = {}) {
  return new RunGuards({ ...limits, meter: new CostMeter(0.10), ...options });
}

test('default policy retains its global and per-page action limits', t => {
  t.mock.method(Date, 'now', () => 0);
  const global = guard(), page = guard();
  for (let index = 0; index < limits.maxSteps; index++) assert.deepEqual(global.nextStep(), { ok: true });
  const globalResult = global.nextStep(); assert.equal(globalResult.ok, false);
  if (!globalResult.ok) assert.match(globalResult.detail ?? '', /step budget exhausted \(30 steps\)/);
  for (let index = 0; index < limits.maxStepsPerPage; index++) assert.deepEqual(page.onPage('same-page'), { ok: true });
  const pageResult = page.onPage('same-page'); assert.equal(pageResult.ok, false);
  if (!pageResult.ok) assert.match(pageResult.detail ?? '', /16 steps on one page/);
});

test('default policy retains inactivity cutoff and progress-earned time and spend', t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const stuck = guard(), meter = new CostMeter(0.10), progressing = guard({ meter });
  now = limits.maxStuckMs + 1;
  const result = stuck.nextStep(); assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.detail ?? '', /stuck for 180s/);
  now = limits.maxTotalMs + 1;
  for (let index = 0; index < limits.maxSteps; index++) progressing.recordProgress();
  meter.record({ prompt_tokens: 750_000 });
  assert.deepEqual(progressing.nextStep(), { ok: true });
});
