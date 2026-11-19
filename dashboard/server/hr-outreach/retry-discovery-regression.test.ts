import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPool } from '../db/index.js';
import { HrStore, listHrOutreachPage } from './store.js';
import { retryHrOutreachForRun } from './retry.js';
import type { DiscoveryOutcome, DiscoveryResult, HiringContact } from './discovery.js';

test('a five-application batch retries only its four unsent lookups and keeps delivered Paxus mail and application history intact', async () => {
  const previousAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'batch-admin@example.test';
  const pool = getPool(), client = await pool.connect();
  const db = { query: (sql: string, params?: any[]) => client.query(sql, params) };
  const options = { connect: async () => ({ ...db, release() {} }) };
  const retryIds = ['28', '30', '31', '32'];
  try {
    // These shadow every table used by the real schema/store/retry paths.
    // No worker, transport, profile access or production records are involved.
    await client.query(`CREATE TEMP TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);
      CREATE TEMP TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id),finished_at TIMESTAMPTZ);
      CREATE TEMP TABLE billing_purchases(id BIGINT PRIMARY KEY,user_id BIGINT,plan_key TEXT);
      CREATE TEMP TABLE application_credit_grants(purchase_id BIGINT,user_id BIGINT,expires_at TIMESTAMPTZ);
      CREATE TEMP TABLE application_email_sends(id BIGINT PRIMARY KEY);
      CREATE TEMP TABLE applications(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id),job_id TEXT,platform TEXT,title TEXT,company TEXT,url TEXT,cover_letter TEXT,
        submitted_by_myasis BOOLEAN,confirmation_status TEXT,outcome TEXT,applied_at TIMESTAMPTZ,location TEXT);
      INSERT INTO users VALUES(1,'batch-admin@example.test',NULL),(2,'batch-admin@example.test',NULL);`);
    await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
    await client.query(`INSERT INTO run_starts(id,user_id,finished_at,hr_ready_at) VALUES(1387,1,now(),now()),(2387,2,now(),now());
      INSERT INTO hr_outreach_preferences(user_id,enabled,enabled_since) VALUES(1,true,now()-interval '1 day'),(2,true,now()-interval '1 day');
      INSERT INTO applications(id,user_id,source_run_id,job_id,platform,title,company,url,cover_letter,submitted_by_myasis,applied_at)
        SELECT n+100,1,1387,'fixture-'||n,'seek','Software role',
          CASE n WHEN 28 THEN 'Argyle' WHEN 29 THEN 'Paxus' WHEN 30 THEN 'Hampr' WHEN 31 THEN 'Howden' ELSE 'HCLTech' END,
          'https://jobs.example.test/'||n,'Private approved candidate evidence',true,now() FROM generate_series(28,32) n;
      INSERT INTO hr_outreach(id,user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,status,lookup_outcome,reason,attempts,retry_allowed,available_at)
        SELECT n,1,n+100,'batch-'||n,'batch-'||n,'fixture-'||n,'seek','Software role',
          CASE n WHEN 28 THEN 'Argyle' WHEN 29 THEN 'Paxus' WHEN 30 THEN 'Hampr' WHEN 31 THEN 'Howden' ELSE 'HCLTech' END,
          'https://jobs.example.test/'||n,CASE WHEN n=29 THEN 'sent' WHEN n=32 THEN 'error' ELSE 'skipped' END,
          CASE n WHEN 28 THEN 'company_unverified' WHEN 29 THEN 'found' WHEN 30 THEN 'no_contact' WHEN 31 THEN 'access_blocked' ELSE 'incomplete' END,
          'Prior public lookup result',4,false,now()+interval '1 day' FROM generate_series(28,32) n;
      UPDATE hr_outreach SET to_email='recruitment@paxus.example.test',subject='Exact delivered subject',body='Exact delivered body',
        message_id='existing-paxus-receipt',thread_id='existing-paxus-thread',send_started_at=now()-interval '5 minutes',sent_at=now()-interval '4 minutes'
        WHERE id=29;
      INSERT INTO hr_company_contacts(company_key,company,contact,reason,validated_at,next_validation_at,lookup_outcome)
        SELECT 'batch-'||n,'Fixture company',NULL,'Prior negative evidence',now()-interval '2 hours',now()+interval '1 day','no_contact'
        FROM generate_series(28,32) n WHERE n<>29;`);
    const store = new HrStore(db);
    const paxusContact: HiringContact = { email: 'recruitment@paxus.example.test', kind: 'recruitment', companyDomain: 'paxus.example.test',
      sourceUrl: 'https://paxus.example.test/careers', sourceText: 'Public recruitment team', validatedAt: new Date().toISOString() };
    await store.saveContact('batch-29', 'Paxus', paxusContact, 'Public recruitment contact verified.');
    const snapshot = async (table: string) => (await client.query(`SELECT * FROM ${table} ORDER BY ${table === 'hr_outreach_preferences' ? 'user_id' : table === 'hr_company_contacts' ? 'company_key' : 'id'}`)).rows;
    const applicationsBefore = await snapshot('applications'), preferencesBefore = await snapshot('hr_outreach_preferences');
    const sentBefore = (await client.query('SELECT * FROM hr_outreach WHERE id=29')).rows[0];
    const positiveBefore = (await client.query("SELECT * FROM hr_company_contacts WHERE company_key='batch-29'")).rows[0];

    for (const [user, run] of [['2', '1387'], ['1', '2387']]) {
      await assert.rejects(retryHrOutreachForRun(user, run, { ...options, expectedIds: retryIds }), /completed run/);
    }
    await assert.rejects(retryHrOutreachForRun('1', '1387', { ...options, expectedIds: [...retryIds, '29'] }), /records changed/);
    assert.deepEqual((await client.query('SELECT id,status,attempts FROM hr_outreach ORDER BY id')).rows.map(row => [row.id, row.status, row.attempts]),
      [['28', 'skipped', 4], ['29', 'sent', 4], ['30', 'skipped', 4], ['31', 'skipped', 4], ['32', 'error', 4]], 'A changed selection must roll back every record');

    const retried = await retryHrOutreachForRun('1', '1387', { ...options, expectedIds: retryIds });
    assert.equal(retried.requeued, 4);
    assert.deepEqual(retried.items.map(item => item.id), retryIds);
    assert.equal((await retryHrOutreachForRun('1', '1387', options)).requeued, 0, 'A repeated request never creates another HR row');
    const queued = (await client.query('SELECT * FROM hr_outreach WHERE id=ANY($1::bigint[]) ORDER BY id', [retryIds])).rows;
    assert.ok(queued.every(row => row.status === 'queued' && row.phase === 'queued' && row.attempts === 0 && row.retry_allowed));
    assert.ok(queued.every(row => !row.to_email && !row.subject && !row.body && !row.send_started_at && !row.message_id && !row.thread_id && !row.sent_at));
    assert.ok((await client.query("SELECT next_validation_at<=now() AS expired FROM hr_company_contacts WHERE company_key<>'batch-29'")).rows.every(row => row.expired), 'Only negative cache entries are made eligible for fresh lookup');
    assert.deepEqual((await client.query("SELECT * FROM hr_company_contacts WHERE company_key='batch-29'")).rows[0], positiveBefore, 'A deliberate retry cannot invalidate or renew the verified positive contact');

    // Persist each new discovery result through the actual store and inspect
    // the same projection used by the owner history API, without sending mail.
    const outcomes: Record<string, DiscoveryOutcome> = { '28': 'company_unverified', '30': 'no_contact', '31': 'access_blocked', '32': 'incomplete' };
    for (const id of retryIds) {
      const claimed = await store.claim();
      assert.ok(claimed); assert.equal(claimed.id, id); assert.equal(claimed.user_id, '1');
      const outcome = outcomes[id], retryable = outcome === 'incomplete';
      const lookup: DiscoveryResult = { contact: null, outcome, retryable, pagesRead: 1, reason: `Public research result: ${outcome}.`,
        diagnostics: { stage: 'public_sources', searches: 1, pagesAttempted: 1, pagesRead: 1, pagesBlocked: outcome === 'access_blocked' ? 1 : 0,
          pagesFailed: 0, candidatesRejected: 0, unresolvedPriorityPages: retryable ? 1 : 0,
          events: [{ stage: 'public_sources', kind: 'fixture_private_detail', detail: 'Internal trace must stay private.' }] } };
      await store.recordLookup(claimed, lookup);
      await store.finish(claimed, retryable ? 'error' : 'skipped', lookup.reason, undefined, 0, { retryable });
    }
    const history = await listHrOutreachPage('1', {}, db);
    assert.equal(history.items.length, 5);
    for (const id of retryIds) {
      const item = history.items.find(row => row.id === id)!;
      assert.equal(item.lookupOutcome, outcomes[id]); assert.ok(item.lookupCheckedAt);
      assert.equal(item.status, id === '32' ? 'error' : 'skipped');
      assert.equal(Boolean(item.lookupRetryAt), id === '32', 'Only an actually scheduled retry gets a date');
      assert.equal(item.toEmail, null); assert.equal(item.body, null);
    }
    assert.doesNotMatch(JSON.stringify(history), /fixture_private_detail|Internal trace must stay private|lookup_diagnostics/);
    assert.equal((await store.claim()), null, 'Terminal lookups and the already-sent email are not dispatched');
    assert.deepEqual((await client.query('SELECT * FROM hr_outreach WHERE id=29')).rows[0], sentBefore, 'Paxus keeps its exact recipient, body, delivery receipt and timestamp');
    assert.deepEqual(await snapshot('applications'), applicationsBefore, 'All five confirmed applications remain unchanged');
    assert.deepEqual(await snapshot('hr_outreach_preferences'), preferencesBefore, 'Account preferences and opt-in cutoff remain unchanged');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM hr_outreach')).rows[0].count, 5);
  } finally {
    client.release(); await pool.end();
    if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousAdmins;
  }
});
