import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { RUN_OUTPUT_DRAIN_MS, runTimeoutMs, signalRunTree, superviseRun } from './run-watchdog.js';

function fixture(onFinish: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> = async () => {}) {
  const events = new EventEmitter();
  const child = events as unknown as ChildProcess;
  const signals: string[] = [];
  const notices: string[] = [];
  const supervisor = superviseRun(child, {
    timeoutMs: 1_000, graceMs: 100,
    signal: (_child, signal) => { signals.push(signal); },
    onTimeout: () => { notices.push('timeout'); },
    onEscalation: () => { notices.push('escalation'); },
    onError: (error) => { notices.push(error.message); },
    onFinish,
  });
  return { events, signals, notices, supervisor };
}

test('Stop escalates once; repeated clicks cannot postpone forced termination', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = fixture();
  run.supervisor.stop();
  t.mock.timers.tick(50);
  run.supervisor.stop();
  t.mock.timers.tick(50);
  assert.deepEqual(run.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(run.notices, ['escalation']);
  run.events.emit('exit', null, 'SIGKILL');
  run.events.emit('close', null, 'SIGKILL');
  await run.supervisor.finished;
  t.mock.timers.tick(10_000);
  assert.deepEqual(run.signals, ['SIGTERM', 'SIGKILL']);
});

test('Whole-run expiry requests termination and escalates an unresponsive worker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = fixture();
  t.mock.timers.tick(999);
  assert.deepEqual(run.signals, []);
  t.mock.timers.tick(1);
  assert.deepEqual(run.notices, ['timeout']);
  assert.deepEqual(run.signals, ['SIGTERM']);
  t.mock.timers.tick(100);
  assert.deepEqual(run.signals, ['SIGTERM', 'SIGKILL']);
  run.events.emit('exit', null, 'SIGKILL');
  run.events.emit('close', null, 'SIGKILL');
  await run.supervisor.finished;
});

test('Worker exit cancels timers, runs cleanup once and waits for resource release without close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  let cleanupCalls = 0;
  let finished = false;
  const run = fixture(async (code, signal) => {
    assert.equal(code, 0);
    assert.equal(signal, null);
    cleanupCalls++;
    await cleanup;
  });
  void run.supervisor.finished.then(() => { finished = true; });
  run.events.emit('exit', 0, null);
  t.mock.timers.tick(RUN_OUTPUT_DRAIN_MS);
  await Promise.resolve();
  assert.equal(cleanupCalls, 1);
  assert.equal(finished, false);
  t.mock.timers.tick(10_000);
  assert.deepEqual(run.signals, []);
  run.events.emit('close', 0, null);
  release();
  await run.supervisor.finished;
  assert.equal(cleanupCalls, 1);
  assert.equal(finished, true);
});

test('Graceful stop cancels escalation and failed spawn still completes cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = fixture();
  run.supervisor.stop();
  run.events.emit('exit', null, 'SIGTERM');
  run.events.emit('close', null, 'SIGTERM');
  await run.supervisor.finished;
  t.mock.timers.tick(10_000);
  assert.deepEqual(run.signals, ['SIGTERM']);
  let failureCode: number | null = null;
  const failed = fixture(async (code) => { failureCode = code; });
  failed.events.emit('error', new Error('synthetic spawn error'));
  await failed.supervisor.finished;
  assert.equal(failureCode, -1);
  assert.deepEqual(failed.signals, []);
});

test('Normal worker exit waits for final output and close before cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sequence: string[] = [];
  const run = fixture(async () => { sequence.push('cleanup'); });
  run.events.on('final-output', () => { sequence.push('submission'); });
  run.events.emit('exit', 0, null);
  await Promise.resolve();
  assert.deepEqual(sequence, []);
  run.events.emit('final-output');
  run.events.emit('close', 0, null);
  await run.supervisor.finished;
  assert.deepEqual(sequence, ['submission', 'cleanup']);
  t.mock.timers.tick(10_000);
  assert.deepEqual(run.signals, []);
});

test('Invalid operator limits cannot disable the watchdog', () => {
  for (const value of [undefined, '', '0', '-5', 'NaN', 'Infinity']) assert.equal(runTimeoutMs(value), 30 * 60_000);
  assert.equal(runTimeoutMs('45'), 45 * 60_000);
  assert.equal(runTimeoutMs('1000'), 120 * 60_000);
});

test('Linux forced stop kills its real worker and descendant while another run stays alive', {
  skip: process.platform !== 'linux', timeout: 5_000,
}, async () => {
  const descendant = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  const worker = spawn(process.execPath, ['-e', `
    process.on('SIGTERM',()=>{});
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}]);
    child.stdout.once('data',()=>console.log('ready '+child.pid));
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const other = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const otherReady = once(other.stdout!, 'data');
  try {
    const [ready] = await once(worker.stdout!, 'data');
    const descendantPid = Number(String(ready).trim().split(' ')[1]);
    assert(Number.isInteger(descendantPid) && descendantPid > 0);
    await otherReady;
    const signals: string[] = [];
    const supervisor = superviseRun(worker, {
      timeoutMs: 10_000, graceMs: 50,
      signal: (child, signal) => { signals.push(signal); signalRunTree(child, signal); },
      onTimeout: () => assert.fail('Unexpected timeout'),
      onEscalation: () => {}, onError: (error) => { throw error; },
      onFinish: async (code, signal) => { assert.equal(code, null); assert.equal(signal, 'SIGKILL'); },
    });
    supervisor.stop();
    await supervisor.finished;
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.doesNotThrow(() => process.kill(other.pid!, 0), 'another run must remain alive');
    // Signal delivery and each group member's exit are asynchronous. The
    // parent's close event does not promise the descendant has exited yet.
    const exitDeadline = performance.now() + 1_000;
    let descendantState: string | undefined;
    do {
      try {
        descendantState = readFileSync(`/proc/${descendantPid}/stat`, 'utf8').split(') ')[1].split(' ')[0];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        descendantState = undefined;
      }
      if (descendantState === undefined || descendantState === 'Z') break;
      await delay(10);
    } while (performance.now() < exitDeadline);
    assert(descendantState === undefined || descendantState === 'Z', `descendant must have exited; observed ${descendantState}`);
  } finally {
    signalRunTree(worker, 'SIGKILL');
    signalRunTree(other, 'SIGKILL');
  }
});
