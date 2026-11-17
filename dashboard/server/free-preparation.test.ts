import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getPool} from './db/index.js';
import {saveApplicationReview,listApplicationReviews,applicationsForConfirmation,claimApplicationReviews,restoreFailedPreparationCredit} from './application-reviews.js';
import {applicationRevision} from '../../seek-bot/src/application-review-content.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';
import {freePreparationNeedsCheck} from './free-preparation.js';

test('Free preparation admission, visibility, confirmation and exact idempotent credit restoration use isolated PostgreSQL',async()=>{
 const pool=getPool(),schema='guest_prep_'+randomUUID().replaceAll('-',''),oldAdmins=process.env.ADMIN_EMAILS;
 pool.options.options=`-c search_path=${schema}`;process.env.ADMIN_EMAILS='admin@fixture.invalid';
 const draft=(jobId:string):PreparedApplication=>{
  const d:PreparedApplication={id:randomUUID(),revision:'',job:{id:jobId,title:'Analyst',company:'Fixture',location:'Sydney',platform:'jora',url:'https://fixture.invalid/jobs/'+jobId,applicationMode:'external'},preparedAt:new Date().toISOString(),formUrl:'https://fixture.invalid/apply',answers:[],coverLetter:'A supported truthful letter.',resume:'Fixture CV.pdf',preparation:{version:2,stage:'job-and-letter',access:'not-checked',listingUrl:'https://fixture.invalid/jobs/'+jobId}};
  d.revision=applicationRevision(d);return d;
 };
 try{
  await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);INSERT INTO users VALUES(1,'admin@fixture.invalid',NULL),(2,'refund@fixture.invalid',NULL),(3,'free@fixture.invalid',NULL),(4,'paid@fixture.invalid',NULL)`);
  const sql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
  for(const table of ['new_user_trials','billing_purchases','application_credit_grants','employer_site_credit_grants','monthly_application_usage','run_starts','application_reviews','application_review_operator_holds'])await pool.query(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  await pool.query('ALTER TABLE run_starts ADD COLUMN finished_at TIMESTAMPTZ;CREATE TABLE applications(id BIGSERIAL,user_id BIGINT,job_id TEXT)');
  await pool.query('INSERT INTO new_user_trials(user_id) VALUES(2),(3),(4)');
  const legacy=draft('unchecked');
  assert.equal(freePreparationNeedsCheck({...legacy,formUrl:'https://www.seek.com.au/job/123',job:{...legacy.job,platform:'seek',applicationMode:'external'}}),true,'a board listing cannot conceal its known employer handoff');
  await assert.rejects(saveApplicationReview('3',legacy),/Guest application access must be confirmed/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM application_reviews')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM monthly_application_usage')).rows[0].n,0,'no credit is spent for unchecked preparation');
  const valid=draft('guest');valid.preparation={version:3,stage:'job-and-letter',access:'guest-confirmed',checkedAt:new Date().toISOString(),checkedUrl:valid.formUrl,evidence:'Apply for this job',isolation:'no-employer-session',method:'form'};valid.revision=applicationRevision(valid);
  await saveApplicationReview('3',valid);await saveApplicationReview('3',valid);
  assert.equal((await pool.query('SELECT successful_applications FROM monthly_application_usage WHERE user_id=3')).rows[0].successful_applications,1);
  await pool.query("INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed) VALUES(3,'jora:unchecked',$1,$2,'ready',true)",[legacy.id,JSON.stringify(legacy)]);
  assert.deepEqual((await listApplicationReviews('3')).map(row=>row.id),[valid.id],'old unchecked drafts are not offered as ready');
  await assert.rejects(applicationsForConfirmation('3',[legacy]),/Guest application access has not been confirmed/);
  await assert.rejects(claimApplicationReviews('3',[legacy]),/Guest application access has not been confirmed/);
  await pool.query("UPDATE application_reviews SET status='failed' WHERE id=$1",[legacy.id]);
  assert.deepEqual((await listApplicationReviews('3')).map(row=>row.id),[valid.id],'unusable historical drafts cannot be offered as retryable prepared jobs either');
  assert.equal((await applicationsForConfirmation('3',[valid])).length,1);
  await pool.query("INSERT INTO billing_purchases(id,user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid) VALUES(1,4,'fixture-paid','intensive-pass',10,0);INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,expires_at) VALUES(4,1,10,now()+interval '1 day')");
  await saveApplicationReview('4',draft('paid-unchecked'));
  assert.equal((await listApplicationReviews('4')).length,1,'paid listing-only preparation is unchanged');
  const refund=draft('refund');
  await pool.query("INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed) VALUES(2,'jora:refund',$1,$2,'failed',true)",[refund.id,JSON.stringify(refund)]);
  await pool.query("INSERT INTO monthly_application_usage(user_id,month_start,successful_applications) VALUES(2,date_trunc('month',now())::date,5)");
  const restore=(actor='1',user='2',selection=refund)=>restoreFailedPreparationCredit(actor,user,selection,'Restore the explicitly approved unusable Free preparation credit.');
  await assert.rejects(restore('3'),/authenticated administrator/);await assert.rejects(restore('1','3'),/owner-scoped/);
  await pool.query("INSERT INTO run_starts(user_id,mode,trigger) VALUES(2,'live','manual')");await assert.rejects(restore(),/active run/);await pool.query('UPDATE run_starts SET finished_at=now()');
  await pool.query("INSERT INTO applications(user_id,job_id) VALUES(2,'refund')");await assert.rejects(restore(),/submitted application/);await pool.query('DELETE FROM applications');
  await assert.rejects(restore('1','2',{...refund,revision:'f'.repeat(64)}),/exact owner-scoped/);
  assert.equal((await pool.query('SELECT successful_applications FROM monthly_application_usage WHERE user_id=2')).rows[0].successful_applications,5,'all rejected operations roll back');
  const result=await Promise.all([restore(),restore()]);assert.equal(result.filter(x=>x.restored).length,1,'concurrent or repeated requests restore exactly once');
  const record=(await pool.query('SELECT payload,status,credit_consumed FROM application_reviews WHERE user_id=2')).rows[0];
  assert.equal((await pool.query('SELECT successful_applications FROM monthly_application_usage WHERE user_id=2')).rows[0].successful_applications,4);
  assert.equal(record.status,'failed');assert.equal(record.credit_consumed,false);assert.equal(record.payload.creditRestoration.actorUserId,'1');
  assert.equal(applicationRevision(record.payload),refund.revision,'refund auditing does not rewrite application or approval bytes');
  assert.equal((await restore()).restored,false);assert.equal((await pool.query('SELECT count(*)::int n FROM billing_purchases WHERE user_id=2')).rows[0].n,0,'refund grants no paid access');
 }finally{if(oldAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldAdmins;await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
