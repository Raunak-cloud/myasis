import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';
import { changeSchedule, nextScheduledStart, scheduleFor, scheduledStart } from './run-schedule.js';

const pool = getPool();
const schema = `schedule_test_${randomUUID().replaceAll('-', '')}`;
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

test('elapsed-time scheduling: four runs per 24h, across midnight and DST; missed slots never catch up', () => {
  for (const date of ['2026-10-03T15:00:00Z', '2026-04-04T15:00:00Z', '2026-10-24T23:59:00Z']) {
    const starts = [new Date(date)];
    for (let n = 0; n < 8; n++) starts.push(nextScheduledStart(starts.at(-1)!, starts.at(-1)!));
    for (let n = 1; n < starts.length; n++) assert.equal(+starts[n] - +starts[n - 1], 6 * 3600_000);
    for (const at of starts) assert.equal(starts.filter(start => +start >= +at && +start < +at + 86400_000).length <= 4, true);
  }
  const last = new Date('2026-01-01T00:00:00Z'), delayed = new Date('2026-01-04T13:00:00Z');
  assert.equal(+nextScheduledStart(delayed, last), +delayed);
  assert.equal(+nextScheduledStart(delayed, delayed), +delayed + 6 * 3600_000);
  assert.equal(+nextScheduledStart(last, last, 1), +last + 24 * 3600_000);
});

test('real DB: opt-in, mode, idempotence, concurrency, pause races, resume gap and crash recovery', async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE users(id bigint PRIMARY KEY);
    INSERT INTO users VALUES(1),(2);
    CREATE TABLE run_starts(user_id bigint, mode text, trigger text, approval_only boolean DEFAULT false, started_at timestamptz DEFAULT now());`);
  const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  const migration = sql.slice(sql.indexOf('-- Explicit opt-in only:'));
  await pool.query(migration); await pool.query(migration);
  assert.equal(await scheduleFor('1'), null, 'migration never activates an existing user');
  await changeSchedule('1', true, 'semi-auto');
  const initial = (await scheduleFor('1'))!;
  assert.equal(initial.enabled, true); assert.equal(initial.application_mode, 'semi-auto');
  await changeSchedule('1', true, 'semi-auto');
  assert.equal((await scheduleFor('1'))!.generation, initial.generation);
  await assert.rejects(changeSchedule('1', true, 'auto'), /Pause/);
  let launches = 0;
  const launch = async () => {
    launches++;
    await pool.query("INSERT INTO run_starts(user_id,mode,trigger) VALUES(1,'live','auto')");
    return { ok: true };
  };
  const results = await Promise.all([1, 2].map(() => scheduledStart('1', initial.generation, 'semi-auto', 4, launch)));
  assert.equal(launches, 1); assert.equal(results.filter(Boolean).length, 1);
  const next = (await scheduleFor('1'))!.next_run_at!;
  await changeSchedule('1', false, 'auto');
  assert.equal(await scheduledStart('1', initial.generation, 'semi-auto', 4, launch), null);
  assert.equal((await scheduleFor('1'))!.next_run_at, null);
  await changeSchedule('1', true, 'semi-auto');
  assert.ok(+new Date((await scheduleFor('1'))!.next_run_at!) >= +new Date(next) - 1000, 'Resume preserves actual-start spacing');
  assert.equal(await scheduledStart('1', (await scheduleFor('1'))!.generation, 'semi-auto', 4, launch), null);
  assert.equal(launches, 1);
  await pool.query("INSERT INTO run_starts(user_id,mode,trigger,started_at) SELECT 1,'live','manual',now()-n*interval '1 minute' FROM generate_series(1,3) n");
  await changeSchedule('1', false, 'semi-auto');
  await changeSchedule('1', true, 'semi-auto');
  assert.ok(+new Date((await scheduleFor('1'))!.next_run_at!) > Date.now() + 23 * 3600_000, 'four recent historical starts cannot bypass the rolling 24h cap');

  // A preparation that arrives after Pause cannot spawn, even if it read the old schedule first.
  await changeSchedule('2', true, 'auto');
  const beforePause = (await scheduleFor('2'))!;
  await changeSchedule('2', false, 'auto');
  assert.equal(await scheduledStart('2', beforePause.generation, 'auto', 4, launch), null);
  // If final admission won the row lock, Pause waits until it can invalidate that generation.
  await changeSchedule('2', true, 'auto');
  const admitted = (await scheduleFor('2'))!;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const starting = scheduledStart('2', admitted.generation, 'auto', 4, async () => { entered(); await gate; return { ok: true }; });
  await inside;
  const pausing = changeSchedule('2', false, 'auto');
  release(); await starting; await pausing;
  assert.equal((await scheduleFor('2'))!.enabled, false);
  assert.equal(await scheduledStart('2', admitted.generation, 'auto', 4, launch), null);

  // Simulate a process crash after a durable run record but before updating its next slot.
  await pool.query("UPDATE application_schedules SET next_run_at = now() - interval '1 day' WHERE user_id=1");
  assert.equal(await scheduledStart('1', (await scheduleFor('1'))!.generation, 'semi-auto', 4, launch), null);
  assert.equal(launches, 1);
  await pool.query('DELETE FROM users WHERE id=2');
  assert.equal(await scheduleFor('2'), null, 'account deletion removes its future jobs');
});
