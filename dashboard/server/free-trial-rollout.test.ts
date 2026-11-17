import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getPool} from './db/index.js';
import {billingStatus} from './billing.js';
import {deriveEntitlements,effectivePlatforms} from './entitlements.js';

test('rollout includes unused existing accounts without resetting balances, prepared work, paid access or preferences',async()=>{
 const pool=getPool(),schema='trial_rollout_'+randomUUID().replaceAll('-','');
 (pool as unknown as {options:{options:string}}).options.options=`-c search_path=${schema}`;
 const sql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(sql);
  await pool.query(`DELETE FROM application_setting_migrations WHERE name='employer-first-unused-trials-v1';
   INSERT INTO users(id,email) SELECT id,'fixture-'||id||'@trial-rollout.invalid' FROM generate_series(1,7) id;
   INSERT INTO monthly_application_usage(user_id,month_start,successful_applications) VALUES(2,current_date,5),(3,current_date,1);
   INSERT INTO applications(user_id,job_id,title,company,submitted_by_myasis) VALUES(4,'previous','Analyst','Fixture',true);
   INSERT INTO application_reviews(user_id,job_key,id,payload,credit_consumed) VALUES(5,'workday:prepared',gen_random_uuid(),'{}',true);
   INSERT INTO settings(user_id,key,value) VALUES(1,'KEYWORDS','Analyst'),(1,'PLATFORMS','seek'),(2,'PLATFORMS','seek');
   UPDATE users SET blocked_at=now() WHERE id=6;
   INSERT INTO billing_purchases(id,user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid) VALUES(77,7,'fixture-paid','essential-pass',50,990);
   INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,credits_used,expires_at) VALUES(7,77,50,3,now()+interval '30 days');`);
  const usage=await pool.query('SELECT * FROM monthly_application_usage ORDER BY user_id'),settings=await pool.query('SELECT * FROM settings ORDER BY user_id,key'),paid=await pool.query('SELECT * FROM application_credit_grants');
  const rollout=sql.slice(sql.indexOf('-- Employer-first trial for accounts still getting started.'));
  await pool.query(rollout);await pool.query(rollout);
  assert.deepEqual((await pool.query('SELECT user_id::text FROM new_user_trials ORDER BY user_id')).rows,[{user_id:'1'}]);
  assert.deepEqual((await pool.query('SELECT * FROM monthly_application_usage ORDER BY user_id')).rows,usage.rows);assert.deepEqual((await pool.query('SELECT * FROM settings ORDER BY user_id,key')).rows,settings.rows);
  assert.deepEqual((await pool.query('SELECT * FROM application_credit_grants')).rows,paid.rows,'paid grants are not changed');
  const billing=await billingStatus('1','fixture-1@trial-rollout.invalid');assert.equal(billing.free.remaining,5);assert.equal(billing.free.trial?.seekBonusAwarded,false);
  const ent=deriveEntitlements({admin:false,billing,autoRunsUsedToday:0,autoApplyPaused:true,hasSuccessfulRun:false,overrides:{evaluationsPerRun:null,maxApplicationsPerRun:null},searchTermSuggestionsLeft:1});
  assert.equal(effectivePlatforms({PLATFORMS:'seek'},ent),'smartrecruiters,greenhouse','an unchanged old SEEK default no longer blocks an unused first-time account');
  await pool.query('DELETE FROM new_user_trials WHERE user_id=1');await pool.query(rollout);assert.equal((await pool.query('SELECT count(*)::int AS n FROM new_user_trials')).rows[0].n,0,'a later schema application cannot re-run the historical rollout');
 }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
