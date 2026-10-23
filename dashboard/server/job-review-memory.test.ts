import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';
import { insertRunEventRow } from './db/records.js';
import { loadReviewMemory } from './job-review-memory.js';

after(async () => { await getPool().end(); });

test('durable rejection memory survives expiry, 500-row retention, 2000 decisions and replay; exports and deletion stay account-scoped', async () => {
  const pool = getPool(), client = await pool.connect();
  const schemaName = `review_memory_test_${randomUUID().replaceAll('-', '')}`;
  const source = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  const block = (name: string) => source.slice(source.indexOf(`-- BEGIN ${name}`), source.indexOf(`-- END ${name}`));
  const migration = block('durable job review memory');
  const original = pool.query;
  const owner = '910000001', peer = '910000002';
  const fingerprint = 'a'.repeat(64), context = 'b'.repeat(64), content = 'c'.repeat(64);
  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await client.query(`SET statement_timeout TO '30s'`);
    await client.query(`CREATE TABLE users(id BIGINT PRIMARY KEY);
      CREATE TABLE review_verdicts(user_id BIGINT, job_id TEXT, verdict TEXT);
      CREATE TABLE run_events(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, job_id TEXT,
        title TEXT, company TEXT, status TEXT NOT NULL, reason TEXT, url TEXT, questions JSONB,
        ts TIMESTAMPTZ NOT NULL, review_disposition TEXT, review_listing_fingerprint TEXT,
        review_context_fingerprint TEXT, review_content_fingerprint TEXT, review_expires_at TIMESTAMPTZ,
        UNIQUE(user_id,job_id,status,ts));
      INSERT INTO users VALUES (${owner}),(${peer});`);
    await client.query(`INSERT INTO run_events(user_id,job_id,status,ts,review_disposition,
      review_listing_fingerprint,review_context_fingerprint,review_expires_at)
      VALUES($1,'legacy','skipped','2026-01-01','fit-mismatch',$2,$3,'2026-01-08')`, [owner, fingerprint, context]);
    await client.query(migration);
    await client.query(block('skipped history retention'));
    // Use the production writer and exporter against this private schema only.
    pool.query = client.query.bind(client) as typeof original;
    await insertRunEventRow(owner, { jobId: 'current', status: 'skipped', title: 'Developer', company: 'Fixture', ts: '2026-02-01',
      reviewCache: { disposition: 'fit-mismatch', listingFingerprint: fingerprint, contextFingerprint: context, contentFingerprint: content, expiresAt: null } });
    await insertRunEventRow(peer, { jobId: 'current', status: 'skipped', ts: '2026-02-01',
      reviewCache: { disposition: 'below-score', listingFingerprint: fingerprint, contextFingerprint: 'd'.repeat(64), expiresAt: null } });
    await client.query(`INSERT INTO run_events(user_id,job_id,status,ts,review_disposition,
      review_listing_fingerprint,review_context_fingerprint,review_content_fingerprint)
      SELECT $1,'job-'||n,'skipped','2026-03-01'::timestamptz+n*interval '1 second',
        'fit-mismatch',lpad(to_hex(n),64,'0'),$2,$3 FROM generate_series(1,2101) n`, [owner, context, content]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM run_events WHERE user_id=$1', [owner])).rows[0].n, 500);
    const remembered = await loadReviewMemory(owner);
    assert.equal(remembered.length, 2103, 'export is not capped at 2000 or limited to the visible skip history');
    assert.ok(remembered.every(row => row.expiresAt === null));
    assert.equal(remembered.find(row => row.jobId === 'current')?.contentFingerprint, content);
    assert.equal(remembered.find(row => row.jobId === 'current')?.contextFingerprint, context);
    // An old replay is pruned immediately, but cannot erase a newer decision.
    await insertRunEventRow(owner, { jobId: 'current', status: 'skipped', ts: '2025-01-01',
      reviewCache: { disposition: 'fit-mismatch', listingFingerprint: fingerprint, contextFingerprint: 'e'.repeat(64), expiresAt: null } });
    await client.query(migration);
    assert.equal((await loadReviewMemory(owner)).find(row => row.jobId === 'current')?.contextFingerprint, context);
    assert.equal((await loadReviewMemory(peer)).length, 1);
    await client.query(`INSERT INTO review_verdicts VALUES($1,'current','apply')`, [owner]);
    assert.ok(!(await loadReviewMemory(owner)).some(row => row.jobId === 'current'), 'explicit candidate overrides remain available');
    await client.query('DELETE FROM users WHERE id=$1', [owner]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM job_review_decisions WHERE user_id=$1', [owner])).rows[0].n, 0);
    assert.equal((await loadReviewMemory(peer)).length, 1, 'deletion cannot remove another account’s memory');
  } finally {
    pool.query = original;
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
  }
});
