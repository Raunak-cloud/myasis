import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunPool } from './runner.js';
import { writeConsole } from './live-console.js';

test('large tool output is byte bounded while billing sees the original receipt', () => {
  const pool = new RunPool();
  const run = Reflect.get(pool, 'forUser').call(pool, 'fixture');
  for (let i = 0; i < 30; i++) run.push('out', `${i}:` + '界'.repeat(100_000));
  const lines = pool.backlog('fixture');
  assert.ok(lines.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0) <= 2 * 1024 * 1024);
  assert.ok(lines.length < 30);
  assert.match(lines.at(-1)!.text, /^29:/);
  let charged = 0;
  run.onApplicationSubmitted = () => { charged++; };
  run.push('out', 'x'.repeat(200_000) + '✅ submitted [external]');
  assert.equal(charged, 1);
  assert.equal(run.state.applied, 1);
});

test('slow console clients disconnect instead of retaining unlimited output', () => {
  let writes = 0, destroyed = 0;
  const response = { writableLength: 1024 * 1024 + 1, write() { writes++; }, destroy() { destroyed++; } };
  writeConsole(response, 'large output');
  assert.equal(writes, 0); assert.equal(destroyed, 1);
  writeConsole({ ...response, writableLength: 0 }, 'progress');
  assert.equal(writes, 1);
});

test('abandoned idle consoles are released while a preparation claim retains its owner', () => {
  const pool = new RunPool();
  const unsubscribe = pool.subscribe('idle-viewer', () => {});
  pool.pruneIdle();
  assert.ok(pool.snapshot().accounts['idle-viewer']);
  unsubscribe(); pool.pruneIdle();
  assert.equal(pool.snapshot().accounts['idle-viewer'], undefined);
  assert.equal(pool.claimStart('preparing'), true);
  pool.subscribe('preparing', () => {})();
  pool.pruneIdle();
  assert.equal(pool.inUse('preparing'), true);
  pool.releaseStart('preparing'); pool.pruneIdle();
  assert.equal(pool.snapshot().accounts.preparing, undefined);
});

test('the worker service reconstructs billing and route cleanup without dashboard closures', async () => {
  const pool = new RunPool();
  const run = Reflect.get(pool, 'forUser').call(pool, 'fixture-policy');
  Object.defineProperty(run, 'disposable', { get: () => false });
  let submitted: unknown, finished: unknown;
  run.start = async (_mode: unknown, _overrides: unknown, _port: unknown, onSubmitted: unknown, onFinished: unknown) => {
    submitted = onSubmitted; finished = onFinished; return { ok: true };
  };
  for (const policy of [
    { chargeSubmission: true, releaseProxy: true },
    { chargeSubmission: false, releaseProxy: true },
    { chargeSubmission: false, releaseProxy: false },
  ]) {
    assert.equal((await pool.start('live', {}, 'fixture-policy', undefined, undefined, null, undefined, policy)).ok, true);
    assert.equal(typeof submitted, policy.chargeSubmission ? 'function' : 'undefined');
    assert.equal(typeof finished, policy.releaseProxy ? 'function' : 'undefined');
  }
});
