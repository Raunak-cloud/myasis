import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPool } from '../db/index.js';
import { listHrOutreachPage } from './store.js';
import { claimDeliveryCheck, deliveryCheckAllowed, deferDeliveryCheck, completeDeliveryCheck, invalidHrAddresses, retryBouncedHrOutreach } from './delivery-store.js';
import type { HrBounce } from './bounce.js';

test('delivery checks preserve five sends, suppress only confirmed invalid addresses and create one separate owner-scoped retry', async () => {
  const savedAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'delivery-admin@example.test';
  const pool = getPool(), client = await pool.connect();
  const db = { query: (sql: string, values?: any[]) => client.query(sql, values) };
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS');
  try {
    await client.query(`CREATE TEMP TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);
      CREATE TEMP TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id),finished_at TIMESTAMPTZ);
      CREATE TEMP TABLE billing_purchases(id BIGINT PRIMARY KEY,user_id BIGINT,plan_key TEXT);
      CREATE TEMP TABLE application_credit_grants(purchase_id BIGINT,user_id BIGINT,expires_at TIMESTAMPTZ);
      CREATE TEMP TABLE application_email_sends(id BIGINT PRIMARY KEY);
      CREATE TEMP TABLE applications(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id),job_id TEXT,platform TEXT,title TEXT,company TEXT,url TEXT,cover_letter TEXT,
        submitted_by_myasis BOOLEAN,confirmation_status TEXT,outcome TEXT,applied_at TIMESTAMPTZ,location TEXT);
      INSERT INTO users VALUES(1,'delivery-admin@example.test',NULL),(2,'ordinary@example.test',NULL);`);
    await client.query(schema); await client.query(schema);
    await client.query(`INSERT INTO run_starts(id,user_id,finished_at,hr_ready_at) VALUES(1387,1,now(),now()),(2387,2,now(),now());
      INSERT INTO hr_outreach_preferences(user_id,enabled,enabled_since) VALUES(1,true,now()-interval '1 day'),(2,true,now()-interval '1 day');
      INSERT INTO applications(id,user_id,source_run_id,job_id,platform,title,company,url,cover_letter,submitted_by_myasis,applied_at,location)
        SELECT n+100,1,1387,'fixture-'||n,'seek','Software engineer',
          CASE n WHEN 28 THEN 'Argyle' WHEN 29 THEN 'Paxus' WHEN 30 THEN 'Hampr' WHEN 31 THEN 'Howden' ELSE 'HCLTech' END,
          'https://jobs.example.test/'||n,'Private approved candidate evidence',true,now(),'Sydney NSW' FROM generate_series(28,32) n;
      INSERT INTO hr_outreach(id,user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,cover_letter,status,to_email,subject,body,
        message_id,thread_id,send_started_at,sent_at,delivery_check_after)
        SELECT n,1,n+100,'batch-'||n,'batch-'||n,'fixture-'||n,'seek','Software engineer',
          CASE n WHEN 28 THEN 'Argyle' WHEN 29 THEN 'Paxus' WHEN 30 THEN 'Hampr' WHEN 31 THEN 'Howden' ELSE 'HCLTech' END,
          'https://jobs.example.test/'||n,'Private approved candidate evidence','sent',
          CASE WHEN n=32 THEN 'invalid-recruiter@hcl.example.test' ELSE 'recruitment-'||n||'@example.test' END,
          'Exact original subject '||n,'Exact original private body '||n,'original-receipt-'||n,'original-thread-'||n,now()-interval '6 minutes',now()-interval '5 minutes',
          CASE WHEN n=32 THEN now() ELSE now()+interval '1 day' END FROM generate_series(28,32) n;
      SELECT setval(pg_get_serial_sequence('hr_outreach','id'),32,true);
      INSERT INTO hr_company_contacts(company_key,company,contact) VALUES
        ('bad-hcl','HCLTech','{"email":"Invalid-Recruiter@hcl.example.test","sourceText":"Public recruitment contact"}'),
        ('same-bad-address','Related public source','{"email":"invalid-recruiter@hcl.example.test","sourceText":"Public business inbox"}'),
        ('valid-hcl','HCLTech','{"email":"verified-recruitment@hcl.example.test","sourceText":"Public recruitment contact"}'),
        ('valid-paxus','Paxus','{"email":"recruitment-29@example.test","sourceText":"Public recruitment contact"}');`);
    const read = async (sql: string, values?: any[]) => (await client.query(sql, values)).rows;
    const appsBefore = await read('SELECT * FROM applications ORDER BY id');
    const prefsBefore = await read('SELECT * FROM hr_outreach_preferences ORDER BY user_id');
    const paxusBefore = (await read('SELECT * FROM hr_outreach WHERE id=29'))[0];
    const sentFields = 'id,user_id,application_id,dedupe_key,status,to_email,subject,body,message_id,thread_id,sent_at,send_started_at,cost_usd';
    const sendsBefore = await read(`SELECT ${sentFields} FROM hr_outreach ORDER BY id`);

    // Every eligibility check is exercised against real rows, not SQL mocks.
    const guards = [
      ["UPDATE users SET blocked_at=now() WHERE id=1", "UPDATE users SET blocked_at=NULL WHERE id=1"],
      ["UPDATE hr_outreach_preferences SET enabled=false WHERE user_id=1", "UPDATE hr_outreach_preferences SET enabled=true WHERE user_id=1"],
      ["UPDATE run_starts SET hr_ready_at=NULL WHERE id=1387", "UPDATE run_starts SET hr_ready_at=now() WHERE id=1387"],
      ["UPDATE applications SET confirmation_status='unconfirmed' WHERE id=132", "UPDATE applications SET confirmation_status=NULL WHERE id=132"],
      ["UPDATE hr_outreach SET message_id=NULL WHERE id=32", "UPDATE hr_outreach SET message_id='original-receipt-32' WHERE id=32"],
      ["UPDATE hr_outreach SET delivery_lease='other',delivery_lease_until=now()+interval '5 minutes' WHERE id=32", "UPDATE hr_outreach SET delivery_lease=NULL,delivery_lease_until=NULL WHERE id=32"],
    ];
    for (const [deny, restore] of guards) {
      await client.query(deny); assert.equal(await claimDeliveryCheck(db), null); await client.query(restore);
    }
    process.env.ADMIN_EMAILS = 'another-admin@example.test';
    assert.equal(await claimDeliveryCheck(db), null); process.env.ADMIN_EMAILS = 'delivery-admin@example.test';
    const originalSentAt = (await read('SELECT sent_at FROM hr_outreach WHERE id=32'))[0].sent_at;
    await client.query("UPDATE hr_outreach SET sent_at=now()-interval '8 days' WHERE id=32");
    assert.equal(await claimDeliveryCheck(db), null); await client.query('UPDATE hr_outreach SET sent_at=$1 WHERE id=32', [originalSentAt]);

    let check = await claimDeliveryCheck(db); assert.ok(check); assert.equal(check.id, '32');
    assert.ok(await deliveryCheckAllowed(db, check));
    assert.equal(await deliveryCheckAllowed(db, { ...check, user_id: '2' }), false);
    assert.equal(await deliveryCheckAllowed(db, { ...check, delivery_lease: 'wrong-lease' }), false);
    assert.equal(await claimDeliveryCheck(db), null, 'An active lease cannot be claimed twice');
    await deferDeliveryCheck(db, check);
    let row = (await read('SELECT *,extract(epoch FROM delivery_check_after-now()) AS wait_seconds FROM hr_outreach WHERE id=32'))[0];
    assert.equal(row.delivery_checks, 0); assert.equal(row.delivery_checked_at, null); assert.equal(row.delivery_lease, null);
    assert.ok(Number(row.wait_seconds) > 20 && Number(row.wait_seconds) <= 30);
    await client.query('UPDATE hr_outreach SET delivery_check_after=now() WHERE id=32');
    check = await claimDeliveryCheck(db); assert.ok(check);
    await completeDeliveryCheck(db, check, null, true);
    row = (await read('SELECT *,extract(epoch FROM delivery_check_after-now()) AS wait_seconds FROM hr_outreach WHERE id=32'))[0];
    assert.equal(row.delivery_checked_at, null, 'A failed mailbox request never looks like a successful delivery check');
    assert.equal(row.delivery_status, 'unknown'); assert.ok(Number(row.wait_seconds) > 290 && Number(row.wait_seconds) <= 300);
    await client.query('UPDATE hr_outreach SET delivery_check_after=now() WHERE id=32');
    check = await claimDeliveryCheck(db); assert.ok(check);
    await completeDeliveryCheck(db, check, null);
    row = (await read('SELECT *,extract(epoch FROM delivery_check_after-now()) AS wait_seconds FROM hr_outreach WHERE id=32'))[0];
    assert.ok(row.delivery_checked_at); assert.equal(row.delivery_status, 'unknown', 'No bounce never means Delivered');
    assert.ok(Number(row.wait_seconds) > 1790 && Number(row.wait_seconds) <= 1800);
    const checkedBeforeFailure = row.delivery_checked_at;
    await client.query('UPDATE hr_outreach SET delivery_check_after=now() WHERE id=32');
    check = await claimDeliveryCheck(db); assert.ok(check);
    await completeDeliveryCheck(db, check, null, true);
    assert.deepEqual((await read('SELECT delivery_checked_at FROM hr_outreach WHERE id=32'))[0].delivery_checked_at, checkedBeforeFailure);

    await client.query('UPDATE hr_outreach SET delivery_check_after=now() WHERE id=32');
    check = await claimDeliveryCheck(db); assert.ok(check);
    const invalid: HrBounce = { action: 'failed', kind: 'invalid_recipient', recipient: 'INVALID-RECRUITER@hcl.example.test', diagnosticCode: '550 5.1.1',
      reason: 'The receiving mail server reported that this email address does not exist.', noticeMessageId: 'notice-hcl-invalid', observedAt: new Date().toISOString() };
    await assert.rejects(completeDeliveryCheck(db, check, { ...invalid, recipient: 'someone-else@example.test' }), /does not match/);
    await assert.rejects(completeDeliveryCheck(db, { ...check, user_id: '2' }, invalid), /no longer available/);
    assert.deepEqual(await invalidHrAddresses(db), []);
    await client.query(`CREATE FUNCTION pg_temp.fail_cache_removal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture cache removal failure'; END$$;
      CREATE TRIGGER fail_cache_removal BEFORE DELETE ON hr_company_contacts FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_cache_removal()`);
    await assert.rejects(completeDeliveryCheck(db, check, invalid), /fixture cache removal failure/);
    assert.equal((await read('SELECT delivery_status FROM hr_outreach WHERE id=32'))[0].delivery_status, 'unknown', 'Bounce, invalid-address protection and cache removal roll back together');
    assert.deepEqual(await invalidHrAddresses(db), []);
    await client.query('DROP TRIGGER fail_cache_removal ON hr_company_contacts');
    await completeDeliveryCheck(db, check, invalid);
    assert.deepEqual(await invalidHrAddresses(db), ['invalid-recruiter@hcl.example.test']);
    assert.deepEqual(await read('SELECT company_key FROM hr_company_contacts ORDER BY company_key'), [{ company_key: 'valid-hcl' }, { company_key: 'valid-paxus' }]);
    const suppressed = (await read('SELECT * FROM hr_invalid_addresses'))[0];
    assert.equal(suppressed.source_outreach_id, '32'); assert.equal(suppressed.diagnostic_code, '550 5.1.1');
    assert.doesNotMatch(JSON.stringify(suppressed), /Exact original private body|Private approved candidate evidence|original-thread/);
    assert.equal(await claimDeliveryCheck(db), null, 'A failed delivery is not sent or checked again as an unknown send');

    // Temporary returns and policy failures do not establish an invalid inbox.
    for (const [id, bounce] of [
      ['28', { ...invalid, action: 'failed', kind: 'policy_rejection', recipient: 'recruitment-28@example.test', diagnosticCode: '550 5.7.1', noticeMessageId: 'notice-policy', reason: 'The receiving mail service rejected this email under its policy.' }],
      ['30', { ...invalid, action: 'delayed', kind: 'temporary_failure', recipient: 'recruitment-30@example.test', diagnosticCode: '450 4.2.0', noticeMessageId: 'notice-delay', reason: 'The receiving mail service temporarily delayed this email.' }],
      ['31', { ...invalid, recipient: 'recruitment-31@example.test', diagnosticCode: '551 5.1.1', noticeMessageId: 'notice-wrong-code' }],
    ] as Array<[string, HrBounce]>) {
      await client.query('UPDATE hr_outreach SET delivery_check_after=now() WHERE id=$1', [id]);
      const next = await claimDeliveryCheck(db); assert.ok(next); assert.equal(next.id, id);
      await completeDeliveryCheck(db, next, bounce);
      assert.deepEqual(await invalidHrAddresses(db), ['invalid-recruiter@hcl.example.test']);
      await assert.rejects(retryBouncedHrOutreach('1', id, db), /not available/);
    }
    assert.equal((await read('SELECT delivery_status FROM hr_outreach WHERE id=30'))[0].delivery_status, 'unknown');

    for (const [user, id] of [['2', '32'], ['1', '29'], ['0', '32'], ['1', 'invalid']]) {
      await assert.rejects(retryBouncedHrOutreach(user, id, db), /valid account|not available/);
    }
    const parentBefore = (await read('SELECT * FROM hr_outreach WHERE id=32'))[0];
    const retry = await retryBouncedHrOutreach('1', '32', db); assert.ok(retry.created);
    const repeated = await retryBouncedHrOutreach('1', '32', db); assert.deepEqual(repeated, { id: retry.id, created: false });
    const child = (await read('SELECT * FROM hr_outreach WHERE id=$1', [retry.id]))[0];
    assert.equal(child.retry_of, '32'); assert.equal(child.outreach_attempt, 2); assert.equal(child.application_id, '132'); assert.equal(child.user_id, '1');
    assert.equal(child.status, 'queued'); assert.equal(child.phase, 'queued'); assert.equal(child.attempts, 0);
    for (const key of ['to_email', 'subject', 'body', 'message_id', 'thread_id', 'send_started_at', 'sent_at']) assert.equal(child[key], null, `A retry must discover and prepare its own ${key}`);
    assert.equal(child.delivery_status, 'unknown');
    assert.match(child.dedupe_key, /:delivery-retry:32$/);
    assert.deepEqual((await read('SELECT * FROM hr_outreach WHERE id=32'))[0], parentBefore, 'Creating the alternative attempt never edits the original bounced send');
    await assert.rejects(client.query(`INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url)
      VALUES(1,132,'other','forged-primary','fixture-32','seek','Software engineer','HCLTech','https://jobs.example.test/32')`), /duplicate/);
    process.env.ADMIN_EMAILS = 'other@example.test'; await assert.rejects(retryBouncedHrOutreach('1', '32', db), /not available/);
    process.env.ADMIN_EMAILS = 'delivery-admin@example.test';
    for (const [deny, restore] of guards.slice(0, 4)) {
      await client.query(deny); await assert.rejects(retryBouncedHrOutreach('1', '32', db), /not available/); await client.query(restore);
    }
    await client.query("UPDATE hr_outreach_preferences SET enabled_since=now()+interval '1 day' WHERE user_id=1");
    await assert.rejects(retryBouncedHrOutreach('1', '32', db), /not available/);
    await client.query('UPDATE hr_outreach_preferences SET enabled_since=$1 WHERE user_id=1', [prefsBefore[0].enabled_since]);

    const history = (await listHrOutreachPage('1', { jobId: 'fixture-32', platform: 'seek' }, db)).items;
    assert.equal(history.length, 2, 'Owner history preserves both attempts for one application');
    const original = history.find(item => item.id === '32')!, successor = history.find(item => item.id === retry.id)!;
    assert.equal(original.status, 'sent'); assert.equal(original.deliveryStatus, 'bounced'); assert.equal(original.toEmail, 'invalid-recruiter@hcl.example.test');
    assert.equal(original.body, 'Exact original private body 32'); assert.equal(successor.outreachAttempt, 2); assert.equal(successor.retryOfId, '32');
    assert.doesNotMatch(JSON.stringify(history), /delivery_diagnostic_code|550 5.1.1|notice-hcl-invalid|delivery_lease/);
    assert.equal((await listHrOutreachPage('2', { jobId: 'fixture-32', platform: 'seek' }, db)).items.length, 0);
    assert.deepEqual((await read('SELECT * FROM hr_outreach WHERE id=29'))[0], paxusBefore, 'Paxus is never reset, resent or relabelled');
    assert.deepEqual(await read(`SELECT ${sentFields} FROM hr_outreach WHERE retry_of IS NULL ORDER BY id`), sendsBefore, 'All five original send ledgers remain exact');
    assert.deepEqual(await read('SELECT * FROM applications ORDER BY id'), appsBefore, 'Application statuses, attachments and evidence never change');
    assert.deepEqual(await read('SELECT * FROM hr_outreach_preferences ORDER BY user_id'), prefsBefore);
    assert.equal((await read('SELECT count(*)::int AS count FROM hr_outreach'))[0].count, 6, 'Only one deliberate successor exists');
    await client.query("UPDATE hr_invalid_addresses SET confirmed_at=now()-interval '2 years'");
    assert.deepEqual(await invalidHrAddresses(db), ['invalid-recruiter@hcl.example.test'], 'Known-invalid mailboxes do not silently expire');
    await client.query('UPDATE hr_invalid_addresses SET cleared_at=now()'); assert.deepEqual(await invalidHrAddresses(db), []);
  } finally {
    client.release(); await pool.end();
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedAdmins;
  }
});

test('a retry snapshot race reads the existing child under fresh owner authority instead of inserting again', async () => {
  const queries: Array<{ sql: string; values?: any[] }> = [];
  const result = await retryBouncedHrOutreach('1', '32', { query: async (sql, values) => {
    queries.push({ sql, values }); return { rows: queries.length === 1 ? [] : [{ id: '33' }] };
  } });
  assert.deepEqual(result, { id: '33', created: false }); assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /INSERT INTO hr_outreach/); assert.doesNotMatch(queries[1].sql, /INSERT|UPDATE|DELETE/);
  assert.match(queries[1].sql, /h\.id=\$1 AND h\.user_id=\$2/); assert.deepEqual(queries[1].values?.slice(0, 2), ['32', '1']);
});
