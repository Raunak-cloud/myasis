import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
process.env.MAX_CONCURRENT_RUNS = '99';
const { autoRunTick } = await import('./autorun.js');
const { getPool } = await import('./db/index.js');
const pool = getPool();
const schema = `autorun_test_${randomUUID().replaceAll('-', '')}`;
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

test('scheduler queues oldest first, respects three slots, mode and Pause, and isolates an account failure', async () => {
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE users(id bigint PRIMARY KEY, email text, blocked_at timestamptz);
    INSERT INTO users SELECT n,'fixture-'||n||'@example.test',NULL FROM generate_series(1,7) n;`);
  const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql.slice(sql.indexOf('-- Explicit opt-in only:')));
  await pool.query(`INSERT INTO application_schedules(user_id,enabled,application_mode,next_run_at)
    SELECT id,id<>7,CASE WHEN id=2 THEN 'semi-auto' ELSE 'auto' END, now()-interval '1 hour'+id*interval '1 minute' FROM users`);
  const seen: string[] = [];
  let active = 0;
  const dependencies = {
    activeCount: () => active,
    busy: () => false,
    start: async (request: Parameters<typeof import('./start-run.js').startRun>[0]) => {
      seen.push(request.userId);
      assert.equal(request.trigger, 'auto');
      assert.equal(request.applicationMode, request.userId === '2' ? 'semi-auto' : 'auto');
      if (request.userId === '1') throw new Error('fixture failure');
      active++;
      await pool.query("UPDATE application_schedules SET next_run_at=now()+interval '6 hours' WHERE user_id=$1", [request.userId]);
      return { ok: true as const, mode: request.mode };
    },
  };
  assert.deepEqual(await autoRunTick(new Date(), dependencies), ['2','3','4']);
  assert.deepEqual(seen, ['1','2','3','4']);
  assert.equal(active, 3, 'even an environment value of 99 cannot exceed three');
  assert.match((await pool.query('SELECT last_error FROM application_schedules WHERE user_id=1')).rows[0].last_error, /fixture failure/);
  assert.deepEqual(await autoRunTick(new Date(), dependencies), [], 'full VPS leaves queued accounts untouched');
  await pool.query('UPDATE application_schedules SET enabled=false,next_run_at=NULL,generation=generation+1 WHERE user_id=5');
  active = 0;
  assert.deepEqual(await autoRunTick(new Date(), dependencies), ['6']);
  assert.ok(!seen.includes('5') && !seen.includes('7'), 'paused accounts never start');
});
