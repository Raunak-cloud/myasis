import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after,test } from 'node:test';
import { getPool } from './db/index.js';
import { claimTechnicalRetries,rememberTechnicalAttempt,exportTechnicalRetries,finishTechnicalRetryLeases,type TechnicalRetryContext } from './technical-retries.js';
import { finishApplicationReviews } from './application-reviews.js';
import type { JobListing } from '../../seek-bot/src/types.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';

after(async()=>{await getPool().end();});

test('durable technical backlog preserves approvals, isolates owners, respects current constraints and holds uncertain sends',async()=>{
 const pool=getPool(),client=await pool.connect(),originalQuery=pool.query,originalConnect=pool.connect;
 const schema='technical_retries_'+randomUUID().replaceAll('-','');
 const directory=mkdtempSync(join(tmpdir(),'owtomate-technical-db-'));
 const source=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
 const migration=source.slice(source.indexOf('-- BEGIN technical application retries'),source.indexOf('-- END technical application retries'));
 const listing=(id:string,extra:Partial<JobListing>={}):JobListing=>({id,platform:'seek',title:'Analyst',company:'Fixture',location:'Sydney',url:'https://www.seek.com.au/job/'+id,ageDays:1,
  description:'Analyse data.',fitReview:{score:90,reason:'Saved match',evidence:['Prior evidence'],contentFingerprint:'old',contextFingerprint:'old'},...extra});
 const context:TechnicalRetryContext={platforms:['seek','indeed'],maxAgeDays:10,excludedCompanies:['Excluded Company'],external:true,externalRemaining:0,scope:'all',deadlineAt:Date.now()+60_000,directory,creditsRemaining:20};
 const error=(job:JobListing,ownerRun='100',extra:Record<string,unknown>={})=>({status:'error',error:'Browser disconnected before submission',ts:new Date().toISOString(),
   technicalAttempt:{job,runId:ownerRun},...extra});
 const state=async(id:string,owner='1')=>(await client.query('SELECT status FROM technical_application_retries WHERE user_id=$1 AND job_key=$2',[owner,'seek:'+id])).rows[0]?.status;
 try{
  await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);
  await client.query(`CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);
   INSERT INTO users VALUES(1,'one@fixture.invalid',NULL),(2,'two@fixture.invalid',NULL);
   CREATE TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT,finished_at TIMESTAMPTZ);
   INSERT INTO run_starts VALUES(100,1,now()),(200,1,NULL),(300,1,NULL),(101,2,now()),(201,2,NULL);
   CREATE TABLE applications(user_id BIGINT,job_id TEXT,platform TEXT,title TEXT,company TEXT,location TEXT,url TEXT,application_url TEXT,confirmation_status TEXT);
   CREATE TABLE run_events(id BIGSERIAL,user_id BIGINT,job_id TEXT,status TEXT,title TEXT,company TEXT,reason TEXT,url TEXT,ts TIMESTAMPTZ,questions JSONB,account_access JSONB,dismissed_at TIMESTAMPTZ);
   CREATE TABLE application_reviews(user_id BIGINT,job_key TEXT,id UUID,payload JSONB,status TEXT,credit_consumed BOOLEAN,security_retry_after TIMESTAMPTZ,updated_at TIMESTAMPTZ,detail TEXT);
   CREATE TABLE application_review_operator_holds(id UUID,user_id BIGINT,job_key TEXT,job JSONB,draft_id UUID,revision TEXT,actor_user_id BIGINT,reason TEXT,held_at TIMESTAMPTZ,released_at TIMESTAMPTZ);
   CREATE TABLE completed_job_reviews(user_id BIGINT,payload JSONB);`);
  await client.query(migration);
  let reads:Promise<unknown>=Promise.resolve();
  pool.query=((sql:any,params?:any)=>{
    const next=reads.then(()=>client.query(sql,params));reads=next.then(()=>undefined,()=>undefined);return next;
  }) as typeof originalQuery;
  pool.connect=(async()=>({query:client.query.bind(client),release:()=>{}})) as unknown as typeof originalConnect;

  const ordinary=listing('ordinary'),savedError=error(ordinary);
  await rememberTechnicalAttempt('1',savedError,directory);
  await rememberTechnicalAttempt('2',savedError,directory);
  assert.equal(await state(ordinary.id),'pending');assert.equal(await state(ordinary.id,'2'),undefined,'another owner cannot import a foreign run');
  await rememberTechnicalAttempt('2',error(ordinary,'101'),directory);

  const approved=listing('approved');
  const draft:PreparedApplication={id:randomUUID(),revision:'exact-approved-revision',job:approved,preparedAt:new Date().toISOString(),formUrl:approved.url,
    coverLetter:'Exact approved letter',resume:'Approved CV.pdf',answers:[{question:'Notice',answer:'Immediate'}]};
  await client.query("INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed,security_retry_after,updated_at) VALUES(1,$1,$2,$3,'failed',true,NULL,now())",['seek:'+approved.id,draft.id,JSON.stringify(draft)]);
  await rememberTechnicalAttempt('1',error(approved,'100',{technicalAttempt:{job:approved,runId:'100',approval:{id:draft.id,revision:draft.revision}}}),directory);

  const uncertain=listing('uncertain');await rememberTechnicalAttempt('1',error(uncertain,'100',{submitPressed:true}),directory);
  assert.equal(await state(uncertain.id),'held');
  const personal=listing('personal');await rememberTechnicalAttempt('1',error(personal,'100',{questions:[{question:'Date of birth?'}]}),directory);
  assert.equal(await state(personal.id),undefined);
  await rememberTechnicalAttempt('1',error(listing('expired',{ageDays:20})),directory);
  await rememberTechnicalAttempt('1',error(listing('excluded',{company:'Excluded Company'})),directory);
  await rememberTechnicalAttempt('1',error(listing('employer-quota',{applicationMode:'external',applicationUrl:'https://employer.example/jobs/quota'})),directory);
  const held=listing('operator-held');await rememberTechnicalAttempt('1',error(held),directory);
  await client.query('INSERT INTO application_review_operator_holds(id,user_id,job_key,job) VALUES($1,1,$2,$3)',[randomUUID(),'seek:'+held.id,JSON.stringify(held)]);
  const duplicate=listing('duplicate');await rememberTechnicalAttempt('1',error(duplicate),directory);
  await client.query('INSERT INTO applications VALUES(1,$1,\'seek\',\'Analyst\',\'Fixture\',\'Sydney\',$2,NULL,NULL)',[duplicate.id,duplicate.url]);

  const rows=await claimTechnicalRetries('1','200',10,context);
  assert.deepEqual(rows.map(x=>x.job.id).sort(),['approved','ordinary']);
  assert.equal(await state('employer-quota'),'pending','jobs outside the remaining employer-site allowance stay queued');
  assert.deepEqual(rows.find(x=>x.approval)?.approval,draft,'resume, letter, answers and revision are preserved exactly');
  assert.equal((await client.query('SELECT credit_consumed FROM application_reviews WHERE id=$1',[draft.id])).rows[0].credit_consumed,true);
  assert.equal((await claimTechnicalRetries('1','200',10,context)).length,0,'one retry per job per run');
  assert.equal((await claimTechnicalRetries('2','201',1,context))[0]?.job.id,'ordinary','the same vacancy is independently retryable for its other owner');

  // Never-started work is released; the existing approval stays usable without another credit.
  await finishTechnicalRetryLeases('1','200',directory);
  assert.equal(await state(ordinary.id),'pending');assert.equal(await state(approved.id),'pending');
  await finishApplicationReviews('1');
  const next=await claimTechnicalRetries('1','300',2,context);
  assert.equal(next.length,2,'unused leases can be retried in a later run');

  // A newer possible send blocks retries even if the preceding failure was safe.
  mkdirSync(join(directory,'traces'),{recursive:true});
  writeFileSync(join(directory,'traces',ordinary.id+'.json'),JSON.stringify({jobId:ordinary.id,job:ordinary,runStartId:'300',sendAudit:{attempted:true}}));
  await finishTechnicalRetryLeases('1','300',directory);
  assert.equal(await state(ordinary.id),'held');
  await rememberTechnicalAttempt('1',{status:'applied',ts:new Date(Date.now()+1000).toISOString(),technicalAttempt:{job:approved,runId:'300'}},directory);
  assert.equal(await state(approved.id),'closed');
  await rememberTechnicalAttempt('1',savedError,directory);
  assert.equal(await state(ordinary.id),'held','a replay cannot replace the newer lease/send uncertainty');
  const legacy=listing('legacy-failure'),legacyDraft={...draft,id:randomUUID(),job:legacy,formUrl:legacy.url};
  await client.query("INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed,security_retry_after,updated_at) VALUES(1,$1,$2,$3,'failed',true,NULL,now())",['seek:'+legacy.id,legacyDraft.id,JSON.stringify(legacyDraft)]);
  writeFileSync(join(directory,'traces',legacy.id+'.json'),JSON.stringify({jobId:legacy.id,job:legacy,runStartId:'100',mode:'approved',savedAt:new Date().toISOString(),
    outcome:{status:'skipped',reason:'Application budget exhausted'},sendAudit:{attempted:false,approvedRevision:legacyDraft.revision}}));
  await exportTechnicalRetries('1',directory);
  const snapshot=JSON.parse(readFileSync(join(directory,'technical-retries.json'),'utf8'));
  assert.ok(snapshot.keys.includes('listing:seek:uncertain'));assert.ok(!snapshot.keys.includes('listing:seek:approved'));
  assert.equal(await state(legacy.id),'pending','existing failed forms with a retained no-send trace are recovered automatically');
  const employer=await claimTechnicalRetries('1','300',1,{...context,externalRemaining:1});
  assert.equal(employer[0]?.job.id,'legacy-failure','normal board retries take priority over employer forms');
  const nextEmployer=await claimTechnicalRetries('1','300',1,{...context,externalRemaining:1});
  assert.equal(nextEmployer[0]?.job.id,'employer-quota','employer retries become eligible when allowance remains');
  await client.query('DELETE FROM users WHERE id=1');
  assert.equal((await client.query('SELECT count(*)::int n FROM technical_application_retries WHERE user_id=1')).rows[0].n,0);
  assert.equal((await client.query('SELECT count(*)::int n FROM technical_application_retries WHERE user_id=2')).rows[0].n,1);
 }finally{
  pool.query=originalQuery;pool.connect=originalConnect;
  await client.query('ROLLBACK');await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-technical-db-'));rmSync(directory,{recursive:true,force:true});
 }
});
