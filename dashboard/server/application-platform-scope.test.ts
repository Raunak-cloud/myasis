import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, after } from 'node:test';
import { getPool } from './db/index.js';

after(async () => { await getPool().end(); });
test('the real migration permits identical ids on different platforms and still blocks same-platform repeats', async () => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE applications (user_id BIGINT, platform TEXT NOT NULL, job_id TEXT NOT NULL,
      CONSTRAINT applications_user_id_job_id_key UNIQUE(user_id,job_id)) ON COMMIT DROP`);
    const schema = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    const migration = schema.slice(schema.indexOf('-- Each platform has its own job-id namespace.'), schema.indexOf('-- Replaces run-log.jsonl.'));
    assert.match(migration, /DROP CONSTRAINT/);
    await client.query(migration); await client.query(migration);
    const insert = `INSERT INTO applications(user_id,platform,job_id) VALUES(1,$1,'same-id')
      ON CONFLICT(user_id,platform,job_id) DO NOTHING RETURNING job_id`;
    assert.equal((await client.query(insert, ['seek'])).rowCount, 1);
    assert.equal((await client.query(insert, ['indeed'])).rowCount, 1);
    assert.equal((await client.query(insert, ['seek'])).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM applications')).rowCount, 2);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
