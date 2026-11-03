/** Real PostgreSQL, disposable schema and synthetic prepaid drafts only. No runs or provider calls. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {getPool,query} from './db/index.js';
import {applicationsForConfirmation,claimApplicationReviews,listApplicationReviews,recordReviewedOutcome} from './application-reviews.js';
import {backfillSecurityRetryCooldowns} from './security-retry.js';
import {SECURITY_RETRY_DELAY_MS} from '../src/securityRetry.js';

const pool=getPool(),schema=`security_retry_${randomUUID().replaceAll('-','')}`;
const dbUrl=new URL(String(pool.options.connectionString));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname),'Fixtures require a local database.');
const control=new pg.Client({connectionString:pool.options.connectionString});
const previousAdmins=process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS='admin@security.fixture.invalid';
const reason='The employer anti-bot security check could not be completed.';
const revision='a'.repeat(64);
const newDraft=async(owner:string,job:string,status='approved')=>{
 const id=randomUUID(),payload={id,revision,job:{id:job,title:'Synthetic analyst',company:'Example employer',platform:'seek',location:'Sydney',url:`https://fixture.invalid/job/${job}`},answers:[],preparedAt:new Date().toISOString()};
 await query('INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed) VALUES($1,$2,$3,$4,$5,true)',[owner,`seek:${job}`,id,JSON.stringify(payload),status]);
 return{id,revision,retry:true};
};
await control.connect();
let created=false;
try{
 await control.query(`CREATE SCHEMA ${schema}`);created=true;pool.options.options=`-c search_path=${schema}`;
 await query('CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT); INSERT INTO users VALUES(1,\'customer@security.fixture.invalid\'),(2,\'other@security.fixture.invalid\'),(3,\'admin@security.fixture.invalid\');');
 await query('CREATE TABLE run_starts(id BIGINT PRIMARY KEY)');
 const schemaSql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
 for(const table of ['application_reviews','application_review_operator_holds','run_events']){
  const statement=schemaSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
  assert.ok(statement);await query(statement);
 }
 const customer=await newDraft('1','blocked');
 const blockedAt=new Date(Date.now()-60_000).toISOString();
 await recordReviewedOutcome('1',customer.id,'skipped',reason,blockedAt);
 const deadline=Date.parse(blockedAt)+SECURITY_RETRY_DELAY_MS;
 const row=()=>query<{status:string;security_retry_after:Date;payload:any;credit_consumed:boolean}>('SELECT status,security_retry_after,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=$2',['1',customer.id]).then(r=>r[0]);
 assert.equal(+(await row()).security_retry_after,deadline);
 assert.equal((await listApplicationReviews('1'))[0].security_retry?.retryAt,new Date(deadline).toISOString());
 await assert.rejects(applicationsForConfirmation('1',[customer]),/retry is available after/);
 const denied=await Promise.allSettled(Array.from({length:4},()=>claimApplicationReviews('1',[customer])));
 assert.ok(denied.every(result=>result.status==='rejected'&&/retry is available after/.test(String((result as PromiseRejectedResult).reason))));
 assert.equal((await row()).status,'failed','direct concurrent requests cannot bypass the timer');
 assert.equal((await row()).credit_consumed,true,'cooldown and refused retries never spend another credit');
 await assert.rejects(claimApplicationReviews('2',[customer]),/no longer ready/);
 // Cover-letter edits may change the draft and updated_at; they cannot move the failure deadline.
 await query("UPDATE application_reviews SET updated_at=now(),payload=jsonb_set(payload,'{coverLetter}',to_jsonb('Edited fixture letter'::text)) WHERE user_id=$1 AND id=$2",['1',customer.id]);
 await recordReviewedOutcome('1',customer.id,'skipped',reason,new Date().toISOString());
 assert.equal(+(await row()).security_retry_after,deadline,'reimports and edits never restart the clock');
 const admin=await newDraft('3','admin-blocked');await recordReviewedOutcome('3',admin.id,'skipped',reason);
 assert.equal((await listApplicationReviews('3'))[0].security_retry,null);
 assert.equal((await applicationsForConfirmation('3',[admin])).length,1);
 assert.equal((await claimApplicationReviews('3',[admin])).length,1,'only the actual admin owner is exempt');
 const generic=await newDraft('1','ordinary-error');await recordReviewedOutcome('1',generic.id,'error','A frame was detached.');
 assert.equal((await listApplicationReviews('1')).find(item=>item.id===generic.id)?.security_retry,null);
 assert.equal((await claimApplicationReviews('1',[generic])).length,1,'ordinary failures stay immediately retryable');
 const mixed=await newDraft('1','mixed-ordinary');await recordReviewedOutcome('1',mixed.id,'error','A frame was detached.');
 await assert.rejects(claimApplicationReviews('1',[customer,mixed]),/retry is available after/);
 assert.equal((await query<{status:string}>('SELECT status FROM application_reviews WHERE id=$1',[mixed.id]))[0].status,'failed','a blocked batch cannot partially consume another approval');
 await query('UPDATE application_reviews SET security_retry_after=$3 WHERE user_id=$1 AND id=$2',['1',customer.id,new Date(Date.now()-60_000)]);
 const races=await Promise.allSettled([claimApplicationReviews('1',[customer]),claimApplicationReviews('1',[customer])]);
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1,'expiry permits exactly one claim, never concurrent sends');
 await recordReviewedOutcome('1',customer.id,'applied','Application submitted.');
 assert.equal((await row()).security_retry_after,null);
 const renewed=await newDraft('2','renewed');await recordReviewedOutcome('2',renewed.id,'skipped',reason,new Date(Date.now()-9*60*60_000).toISOString());
 await claimApplicationReviews('2',[renewed]);await recordReviewedOutcome('2',renewed.id,'skipped',reason);
 const renewedAt=(await query<{security_retry_after:Date}>('SELECT security_retry_after FROM application_reviews WHERE id=$1',[renewed.id]))[0].security_retry_after;
 assert.ok(+renewedAt>Date.now()+7*60*60_000,'a genuinely new security failure starts its own eight-hour wait');
 const legacy=await newDraft('2','legacy','failed'),oldAt=new Date(Date.now()-2*60*60_000);
 await query('UPDATE application_reviews SET detail=$3 WHERE user_id=$1 AND id=$2',['2',legacy.id,reason]);
 await query('INSERT INTO run_events(user_id,job_id,status,reason,ts) VALUES($1,$2,$3,$4,$5)',['2','legacy','skipped',reason,oldAt]);
 const before=await query('SELECT status,detail,payload,credit_consumed,updated_at FROM application_reviews WHERE id=$1',[legacy.id]);
 assert.equal(await backfillSecurityRetryCooldowns(),1);
 const recovered=await query<{security_retry_after:Date}>('SELECT security_retry_after FROM application_reviews WHERE id=$1',[legacy.id]);
 assert.equal(+recovered[0].security_retry_after,+oldAt+SECURITY_RETRY_DELAY_MS,'existing failures use their actual event time');
 assert.equal(await backfillSecurityRetryCooldowns(),0,'backfill is idempotent');
 assert.deepEqual(await query('SELECT status,detail,payload,credit_consumed,updated_at FROM application_reviews WHERE id=$1',[legacy.id]),before,'initialization preserves approval, document, credit and audit fields');
 console.log('PASS security retry: eight-hour persistence, direct/concurrent API denial, owner isolation, real admin exemption, non-security recovery, unchanged deadline on edits/imports, expiry single claim, applied clearing and idempotent historical initialization. Synthetic local PostgreSQL only.');
}finally{
 await pool.end();if(created)await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();
 if(previousAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=previousAdmins;
}
