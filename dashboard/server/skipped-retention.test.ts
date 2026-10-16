import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';

after(async () => { await getPool().end(); });

test('database retains the newest 500 skips per owner across migration, imports and concurrent writers', async () => {
  const pool = getPool();
  const schemaName = `skip_retention_test_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect();
  const second = await pool.connect();
  const other = await pool.connect();
  const owner = 910000001;
  const peer = 910000002;
  const schema = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  const start = schema.indexOf('-- BEGIN skipped history retention');
  const end = schema.indexOf('-- END skipped history retention');
  assert.ok(start >= 0 && end > start);
  const migration = schema.slice(start, end);
  try {
    // A private schema and private sequence: never alter real accounts or history.
    await client.query(`CREATE SCHEMA ${schemaName}`);
    for (const connection of [client, second, other]) {
      await connection.query(`SET search_path TO ${schemaName}, public`);
      await connection.query(`SET statement_timeout TO '10s'`);
    }
    await client.query(`CREATE TABLE run_events (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, job_id TEXT,
      status TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, reason TEXT,
      UNIQUE(user_id, job_id, status, ts));
      CREATE TABLE applications (user_id BIGINT, job_id TEXT);
      INSERT INTO applications VALUES (${owner}, 'sent-before-retention');
      INSERT INTO run_events(user_id, job_id, status, ts)
        SELECT owner, 'job-' || n, 'skipped', '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 second'
        FROM unnest(ARRAY[${owner}, ${peer}]::bigint[]) owner CROSS JOIN generate_series(1, 1200) n;
      INSERT INTO run_events(user_id, job_id, status, ts)
        SELECT ${owner}, 'attention-' || n, 'needs-human', '2025-01-01' FROM generate_series(1, 600) n;
      INSERT INTO run_events(user_id, job_id, status, ts)
        VALUES (${owner}, 'error', 'error', '2025-01-01'),
               (${owner}, 'sent', 'applied', '2025-01-01');`);
    await client.query(migration);
    await client.query(migration);
    const counts = await client.query(`SELECT user_id::text, count(*)::int AS n
      FROM run_events WHERE status = 'skipped' GROUP BY user_id ORDER BY user_id`);
    assert.deepEqual(counts.rows.map(({ user_id, n }) => ({ user_id, n })), [
      { user_id: String(owner), n: 500 }, { user_id: String(peer), n: 500 },
    ]);
    const retained = await client.query(`SELECT job_id FROM run_events WHERE user_id = $1 AND status = 'skipped' ORDER BY ts`, [owner]);
    assert.equal(retained.rows[0].job_id, 'job-701');
    assert.equal(retained.rows.at(-1)?.job_id, 'job-1200');
    assert.equal((await client.query(`SELECT * FROM run_events WHERE status <> 'skipped'`)).rowCount, 602);
    assert.equal((await client.query('SELECT * FROM applications')).rowCount, 1);

    const insert = `INSERT INTO run_events(user_id,job_id,status,ts,reason) VALUES($1,$2,'skipped',$3,$4)
      ON CONFLICT(user_id,job_id,status,ts) DO UPDATE SET reason = EXCLUDED.reason`;
    // Old logs cannot push newer records out; repeat imports stay bounded.
    await client.query(insert, [owner, 'old-import', '2020-01-01', 'old']);
    await client.query(insert, [owner, 'job-1200', '2026-01-01T00:20:00Z', 'updated']);
    assert.equal((await client.query(`SELECT * FROM run_events WHERE job_id = 'old-import'`)).rowCount, 0);
    assert.equal((await client.query(`SELECT reason FROM run_events WHERE user_id=$1 AND job_id='job-1200'`, [owner])).rows[0].reason, 'updated');

    // Tie-breaking must be stable, using the later id when times are equal.
    await client.query(`INSERT INTO run_events(user_id,job_id,status,ts)
      SELECT $1, 'tie-' || n, 'skipped', '2027-01-01' FROM generate_series(1, 501) n`, [owner]);
    assert.equal((await client.query(`SELECT * FROM run_events WHERE user_id=$1 AND job_id='tie-1'`, [owner])).rowCount, 0);
    assert.equal((await client.query(`SELECT * FROM run_events WHERE user_id=$1 AND job_id='tie-501'`, [owner])).rowCount, 1);

    // Hold one writer open. A second writer must wait before conflict handling,
    // while a different account can still write normally.
    await client.query('BEGIN');
    await client.query(insert, [owner, 'parallel-first', '2028-01-01', 'first']);
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = second.query(insert, [owner, 'tie-2', '2027-01-01', 'reimport while oldest is pruned']);
    // Attach rejection immediately so a timeout cannot become unhandled.
    const outcome = pending.then(() => null, (error: Error) => error);
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (!waiting && Date.now() < deadline) {
      waiting = (await other.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted`, [pid])).rowCount === 1;
      if (!waiting) await new Promise(done => setTimeout(done, 10));
    }
    assert.ok(waiting, 'parallel same-owner writer waits on the retention lock');
    await other.query(insert, [peer, 'other-owner', '2028-01-01', 'independent']);
    await client.query('COMMIT');
    assert.equal(await outcome, null);
    // The reimport has a new id, so it wins the tie against the next oldest row.
    assert.equal((await client.query(`SELECT reason FROM run_events WHERE user_id=$1 AND job_id='tie-2'`, [owner])).rows[0].reason, 'reimport while oldest is pruned');
    assert.equal((await client.query(`SELECT * FROM run_events WHERE user_id=$1 AND job_id='tie-3'`, [owner])).rowCount, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM run_events WHERE user_id=$1 AND status='skipped'`, [owner])).rows[0].n, 500);

    // Updating an existing non-skip into a skip also enforces the cap.
    await client.query(`UPDATE run_events SET status='skipped', ts='2029-01-01' WHERE user_id=$1 AND job_id='error'`, [owner]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM run_events WHERE user_id=$1 AND status='skipped'`, [owner])).rows[0].n, 500);
    assert.equal((await client.query(`SELECT * FROM run_events WHERE status='needs-human'`)).rowCount, 600);
    assert.equal((await client.query('SELECT * FROM applications')).rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    for (const connection of [second, other, client]) {
      await connection.query('RESET search_path; RESET statement_timeout');
    }
    // schemaName is generated here, never derived from user input or a path.
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release(); second.release(); other.release();
  }
});
