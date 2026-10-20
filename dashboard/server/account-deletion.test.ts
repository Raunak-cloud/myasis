import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { getPool } from './db/index.js';
import { purgeAccountData } from './account-deletion.js';

const pool = getPool();
const schema = `account_deletion_test_${randomUUID().replaceAll('-', '')}`;
const temporary = mkdtempSync(resolve(tmpdir(), 'owtomate-account-delete-'));
const root = resolve(temporary, 'users');
const client = await pool.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));
  await client.query(`INSERT INTO users(id,email) VALUES(1,'delete@example.test'),(2,'keep@example.test');
    INSERT INTO profiles(user_id,full_name) VALUES(1,'Private Candidate'),(2,'Peer Candidate');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('deleted-session',1,now()+interval '1 day'),('peer-session',2,now()+interval '1 day');
    INSERT INTO settings(user_id,key,value) VALUES(1,'DAILY_SUMMARY_EMAILS','off'),(2,'DAILY_SUMMARY_EMAILS','on');
    INSERT INTO resumes(user_id,label,file_name) VALUES(1,'Private CV','cv.pdf'),(2,'Peer CV','peer.pdf');
    INSERT INTO knowledge_items(user_id,label,kind,body) VALUES(1,'Private note','note','private');
    INSERT INTO applications(user_id,job_id,title,company) VALUES(1,'private-job','Role','Employer'),(2,'peer-job','Peer role','Peer employer');
    INSERT INTO run_events(user_id,job_id,status) VALUES(1,'private-job','needs-human');
    INSERT INTO saved_answers(user_id,question,answer) VALUES(1,'Private question','Private answer');
    INSERT INTO google_connections(user_id,refresh_token) VALUES(1,'private-token');
    INSERT INTO billing_purchases(user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid)
      VALUES(1,'cs_deletion_fixture','essential-pass',50,990);
    INSERT INTO application_credit_grants(user_id,purchase_id,credits_total) SELECT 1,id,50 FROM billing_purchases;
    INSERT INTO run_starts(user_id,mode,trigger) VALUES(1,'live','auto');
    INSERT INTO daily_digests(user_id,day) VALUES(1,current_date);
    INSERT INTO site_accounts(user_id,site,email) VALUES(1,'fixture.invalid','delete@example.test');
    INSERT INTO application_cost_events(user_id,event_id,run_id,payload) VALUES(1,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','{}');
    INSERT INTO page_views(visitor_id,session_id,user_id,page) VALUES
      ('shared-visitor','owner',1,'setup'),('shared-visitor','anonymous',NULL,'landing'),
      ('shared-visitor','peer',2,'setup'),('unrelated-visitor','unrelated',NULL,'landing');`);
  const site = randomUUID();
  await client.query("INSERT INTO marketing_sites(id,user_id,url,cta_url) VALUES($1,1,'https://fixture.invalid','https://fixture.invalid')", [site]);
  for (const path of [resolve(root,'1','resumes'),resolve(root,'1','chrome'),resolve(root,'2'),resolve(temporary,'deleted','1-old'),resolve(temporary,'deleted','10-keep')]) mkdirSync(path,{recursive:true});
  writeFileSync(resolve(root,'1','resumes','cv.pdf'),'private fixture');
  writeFileSync(resolve(root,'1','chrome','Cookies'),'private session');
  writeFileSync(resolve(root,'2','peer.txt'),'keep');
  const job = randomUUID();
  await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,status,idempotency_key) VALUES($1,$2,1,'research','running','fixture-job')", [job,site]);
  await client.query('BEGIN');
  await assert.rejects(() => purgeAccountData(client,'1',root),/research task is finishing/);
  await client.query('ROLLBACK');
  assert.equal(existsSync(resolve(root,'1','resumes','cv.pdf')),true,'a busy account keeps its data for retry');
  await client.query("UPDATE marketing_jobs SET status='done'");
  await client.query('BEGIN');
  await assert.rejects(() => purgeAccountData(client,'1',root,async () => { throw new Error('Fixture filesystem failure'); }),/Fixture filesystem failure/);
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT * FROM users WHERE id=1')).rowCount,1,'filesystem failure cannot delete the account or sessions');
  assert.equal((await client.query('SELECT * FROM page_views WHERE user_id=1')).rowCount,1,'database changes roll back on filesystem failure');
  await client.query('BEGIN');
  await purgeAccountData(client, '1', root);
  await client.query('COMMIT');
  assert.equal(existsSync(resolve(root,'1')),false);
  assert.equal(existsSync(resolve(temporary,'deleted','1-old')),false);
  assert.equal(existsSync(resolve(root,'2','peer.txt')),true);
  assert.equal(existsSync(resolve(temporary,'deleted','10-keep')),true);
  assert.deepEqual((await client.query('SELECT id::text FROM users')).rows,[{id:'2'}]);
  assert.deepEqual((await client.query('SELECT session_id FROM page_views ORDER BY session_id')).rows,[{session_id:'peer'},{session_id:'unrelated'}]);
  const owned = await client.query(`SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='user_id'`, [schema]);
  for (const {table_name} of owned.rows) {
    assert.match(table_name, /^[a-z_]+$/);
    assert.equal((await client.query(`SELECT 1 FROM ${table_name} WHERE user_id=1`)).rowCount,0,`${table_name} must contain no deleted-account data`);
  }
  assert.equal((await client.query('SELECT * FROM sessions WHERE user_id=2')).rowCount,1);
  assert.equal((await client.query('SELECT * FROM applications WHERE user_id=2')).rowCount,1);
  await assert.rejects(() => purgeAccountData(client,'../2',root),/Invalid account/);
  await assert.rejects(() => purgeAccountData(client,'999',root),/Account not found/);
  console.log('PASS: real isolated PostgreSQL schema cascades, private files/browser sessions/legacy deletion, linked anonymous visits, owner isolation and path validation.');
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.query('SET search_path TO public');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release(); await pool.end();
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+sep+'owtomate-account-delete-'));
  rmSync(temporary,{recursive:true,force:true});
}
