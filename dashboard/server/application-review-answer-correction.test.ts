import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {getPool,query} from './db/index.js';
import {userDir,USERS_DIR} from './userdata.js';
import {correctHeldReviewAnswers,heldAnswerCorrectionPlan,type HeldAnswerCorrectionPlan} from './application-review-answer-correction.js';
import {holdApplicationReview,claimApplicationReviews,releaseApplicationReviewHold,saveApplicationReview} from './application-reviews.js';
import {applicationRevision} from '../../seek-bot/src/application-review-content.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

const pool=getPool(),url=new URL(String(pool.options.connectionString));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Answer-correction tests require isolated local PostgreSQL.');
const schema=`answer_correction_${randomUUID().replaceAll('-','')}`;
assert.match(schema,/^answer_correction_[a-f0-9]{32}$/);
const owner=`7${Date.now()}`,other=String(BigInt(owner)+1n),actor=String(BigInt(owner)+2n),outsider=String(BigInt(owner)+3n);
const directory=resolve(userDir(owner));
assert.ok(directory.startsWith(resolve(USERS_DIR)+sep)&&directory.endsWith(sep+owner)&&!existsSync(directory));
const previousAdmins=process.env.ADMIN_EMAILS;process.env.ADMIN_EMAILS='operator@answer.fixture.invalid';
const admin=new pg.Client({connectionString:pool.options.connectionString});
const started=new Date(Date.now()-120_000),finished=new Date(Date.now()-1000);
let schemaCreated=false,directoryCreated=false,number=0;
const journal:string[]=[];
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(answer='I prepared accurate reports using Excel and Fictional Sheets.'){
  const job=String(++number),preparedAt=new Date(Date.now()-60_000).toISOString(),attemptId=randomUUID();
  const original:PreparedApplication={id:randomUUID(),revision:'',preparedAt,
    job:{id:job,title:'Fictional analyst',company:'Fixture',platform:'seek',location:'Sydney',url:`https://fixture.invalid/job/${job}`},
    formUrl:`https://fixture.invalid/job/${job}/review`,answers:[{question:'Reporting experience',answer},{question:'Known availability',answer:'Two weeks'}],
    resumeId:'resume-fixture',resume:'CV.pdf',resumeHash:'1'.repeat(64),coverLetter:'Unchanged exact letter.',
    documents:[{role:'cover-letter',provenance:'file',fileId:'supporting:1',name:'Letter.txt',sha256:'2'.repeat(64),bytes:23,text:'Unchanged exact letter.'}]};
  original.revision=applicationRevision(original);
  await query('INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed,detail) VALUES($1,$2,$3,$4,\'ready\',true,\'Original status detail\')',
    [owner,`seek:${job}`,original.id,JSON.stringify(original)]);
  journal.push(JSON.stringify({ts:preparedAt,status:'prepared',draft:original}));writeFileSync(resolve(directory,'run-log.jsonl'),journal.join('\n')+'\n');
  const completedAt=new Date(Date.parse(preparedAt)-1000).toISOString();
  const trace:any={runStartId:'1',attemptId,jobId:job,job:original.job,mode:'prepare',startedAt:new Date(Date.parse(preparedAt)-5000).toISOString(),savedAt:preparedAt,
    outcome:{status:'prepared',draft:original},sendAudit:{attempted:false},steps:[
      {step:1,tool:'browser_action',args:{action:'fill'},execution:'started',completedAt},
      {step:2,tool:'browser_action',args:{action:'press',sends_application:false},execution:'started',completedAt},
      {step:3,tool:'browser_action',args:{action:'script',script_intent:'inspect'},execution:'started',completedAt},
      {step:4,tool:'browser_action',args:{action:'invalid-argument'},execution:'not-started',completedAt},
    ]};
  const path=resolve(directory,'traces',`attempt-${attemptId}.json`);writeFileSync(path,JSON.stringify(trace));
  const hold=await holdApplicationReview(actor,owner,{id:original.id,revision:original.revision},'Factual operator review required.','1');
  const plan:HeldAnswerCorrectionPlan={operationId:randomUUID(),actorUserId:actor,userId:owner,draftId:original.id,holdId:hold.id,
    originalRevision:original.revision,currentRevision:original.revision,sourceRunId:'1',attemptId,expectedTraceSha256:hash(readFileSync(path)),
    reason:'Remove an unsupported tool claim.',evidence:'Operator audited the owner source evidence; only Excel is supported.',
    changes:[{question:'Reporting experience',before:original.answers[0].answer,after:'I prepared accurate reports using Excel.'}]};
  return{original,trace,path,plan,hold,writeTrace(){writeFileSync(path,JSON.stringify(trace));plan.expectedTraceSha256=hash(readFileSync(path));}};
}
await admin.connect();
try{
  await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;pool.options.options=`-c search_path=${schema}`;
  await query('CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);CREATE TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ);CREATE TABLE applications(user_id BIGINT,platform TEXT,job_id TEXT,confirmation_status TEXT);');
  await query('INSERT INTO users VALUES($1,$2,NULL),($3,$4,NULL),($5,$6,NULL),($7,$8,NULL)',[owner,'owner@answer.fixture.invalid',other,'other@answer.fixture.invalid',actor,'operator@answer.fixture.invalid',outsider,'nonadmin@answer.fixture.invalid']);
  await query('INSERT INTO run_starts VALUES(1,$1,$2,$3),(2,$4,$2,$3)',[owner,started,finished,other]);
  const sql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
  for(const table of ['application_reviews','application_review_operator_holds','application_review_operator_answer_revisions']){
    const statement=sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];assert.ok(statement);await query(statement);
  }
  await query('CREATE UNIQUE INDEX application_review_one_active_hold_idx ON application_review_operator_holds(user_id,job_key) WHERE released_at IS NULL');
  mkdirSync(directory);directoryCreated=true;mkdirSync(resolve(directory,'traces'));
  const good=await fixture();
  for(const extra of [{path:'arbitrary'},{release:true},{status:'approved'},{command:'arbitrary'},{candidate:true}])assert.throws(()=>heldAnswerCorrectionPlan({...good.plan,...extra}),/closed/);
  assert.throws(()=>heldAnswerCorrectionPlan({...good.plan,changes:[{...good.plan.changes[0],extra:'unsupported'}]}),/exact question/);
  assert.throws(()=>heldAnswerCorrectionPlan({...good.plan,changes:[good.plan.changes[0],good.plan.changes[0]]}),/only once/);
  assert.throws(()=>heldAnswerCorrectionPlan({...good.plan,changes:[{...good.plan.changes[0],after:' ' }]}),/nonempty/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,actorUserId:outsider}),/active administrator/);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1',[actor]);await assert.rejects(correctHeldReviewAnswers(good.plan),/active administrator/);await query('UPDATE users SET blocked_at=NULL WHERE id=$1',[actor]);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1',[owner]);await assert.rejects(correctHeldReviewAnswers(good.plan),/owner.*blocked/);await query('UPDATE users SET blocked_at=NULL WHERE id=$1',[owner]);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,userId:other}),/source run does not belong/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,currentRevision:'f'.repeat(64)}),/revision changed/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,originalRevision:'f'.repeat(64)}),/original operator hold/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,holdId:randomUUID()}),/original operator hold/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,sourceRunId:'2'}),/source run/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,expectedTraceSha256:'f'.repeat(64)}),/immutable trace/);
  await assert.rejects(correctHeldReviewAnswers({...good.plan,changes:[{...good.plan.changes[0],before:'A guessed previous answer'}]}),/exact answer selection/);
  for(const status of ['approved','applied','failed','dismissed']){const item=await fixture();await query('UPDATE application_reviews SET status=$3 WHERE user_id=$1 AND id=$2',[owner,item.original.id,status]);await assert.rejects(correctHeldReviewAnswers(item.plan),/imported.*unconfirmed/);}
  const uncredited=await fixture();await query('UPDATE application_reviews SET credit_consumed=false WHERE user_id=$1 AND id=$2',[owner,uncredited.original.id]);await assert.rejects(correctHeldReviewAnswers(uncredited.plan),/credited/);
  const nonheld=await fixture();await releaseApplicationReviewHold(actor,owner,nonheld.hold.id,{id:nonheld.original.id,revision:nonheld.original.revision},{id:nonheld.original.id,revision:nonheld.original.revision},'Synthetic release for nonheld negative test.');await assert.rejects(correctHeldReviewAnswers(nonheld.plan),/no longer active/);
  await query('UPDATE run_starts SET finished_at=NULL WHERE id=1');await assert.rejects(correctHeldReviewAnswers(good.plan),/every application run/);await query('UPDATE run_starts SET finished_at=$1 WHERE id=1',[finished]);
  await query('INSERT INTO run_starts VALUES(3,$1,now(),NULL)',[owner]);await assert.rejects(correctHeldReviewAnswers(good.plan),/every application run/);await query('DELETE FROM run_starts WHERE id=3');
  for(const patch of [
    (t:any)=>{t.sendAudit.attempted=true;},(t:any)=>{t.outcome.status='applied';},(t:any)=>{t.mode='auto';},
    (t:any)=>{delete t.steps[0].completedAt;},(t:any)=>{t.steps[1].args.sends_application=true;},
    (t:any)=>{delete t.steps[1].args.sends_application;},(t:any)=>{t.steps[2].args.script_intent='act';},
    (t:any)=>{t.jobId='another-job';},(t:any)=>{t.runStartId='2';},(t:any)=>{t.outcome.draft.answers[0].answer='Corrupt original revision';},
  ]){const item=await fixture();patch(item.trace);item.writeTrace();await assert.rejects(correctHeldReviewAnswers(item.plan),/immutable trace|revision integrity/);}
  const knownSend=await fixture();await query('INSERT INTO applications VALUES($1,\'seek\',$2,\'unconfirmed\')',[owner,knownSend.original.job.id]);await assert.rejects(correctHeldReviewAnswers(knownSend.plan),/uncertain send/);
  const ambiguous=await fixture();const dupe={...ambiguous.original,answers:[...ambiguous.original.answers,ambiguous.original.answers[0]]};dupe.revision=applicationRevision(dupe);
  await query('UPDATE application_reviews SET payload=$3 WHERE user_id=$1 AND id=$2',[owner,dupe.id,JSON.stringify(dupe)]);await assert.rejects(correctHeldReviewAnswers({...ambiguous.plan,currentRevision:dupe.revision}),/ambiguous/);
  const bound=await fixture('Unchanged exact letter.');await assert.rejects(correctHeldReviewAnswers(bound.plan),/document or cover-letter workflow/);

  const sourceBefore=readFileSync(good.path),journalBefore=readFileSync(resolve(directory,'run-log.jsonl'));
  const result=await correctHeldReviewAnswers(good.plan);
  assert.equal(result.alreadyCurrent,false);assert.equal(result.auditId,good.plan.operationId);assert.notEqual(result.application.revision,good.original.revision);
  assert.equal(result.application.preparedAt,good.original.preparedAt);assert.equal(result.application.id,good.original.id);
  assert.deepEqual({...result.application,answers:good.original.answers,revision:good.original.revision},good.original,'all content outside the selected answers and revision is unchanged');
  assert.equal(result.application.answers[0].answer,good.plan.changes[0].after);assert.equal(result.application.answers[1].answer,good.original.answers[1].answer);
  const stored=(await query('SELECT payload,status,credit_consumed,detail FROM application_reviews WHERE user_id=$1 AND id=$2',[owner,good.original.id]))[0];
  assert.equal(stored.status,'ready');assert.equal(stored.credit_consumed,true);assert.equal(stored.detail,'Original status detail');assert.equal(applicationRevision(stored.payload),stored.payload.revision);
  const audit=(await query('SELECT * FROM application_review_operator_answer_revisions WHERE id=$1',[good.plan.operationId]))[0];
  assert.equal(String(audit.actor_user_id),actor);assert.equal(audit.original_revision,good.original.revision);assert.equal(audit.previous_revision,good.original.revision);assert.equal(audit.current_revision,result.application.revision);
  assert.deepEqual(audit.plan.changes,good.plan.changes);assert.equal(audit.source_trace_sha256,hash(sourceBefore));assert.ok(+new Date(audit.corrected_at)>Date.parse(good.original.preparedAt));
  assert.deepEqual(readFileSync(good.path),sourceBefore);assert.deepEqual(readFileSync(resolve(directory,'run-log.jsonl')),journalBefore);
  assert.equal((await query('SELECT released_at FROM application_review_operator_holds WHERE id=$1',[good.hold.id]))[0].released_at,null);
  await assert.rejects(claimApplicationReviews(owner,[{id:good.original.id,revision:result.application.revision}]),/no longer ready/);
  assert.equal((await correctHeldReviewAnswers(good.plan)).alreadyCurrent,true,'same closed operation is idempotent after JSONB key reordering');
  await assert.rejects(correctHeldReviewAnswers({...good.plan,reason:'Different operation evidence'}),/different evidence/);
  await saveApplicationReview(owner,good.original);
  assert.equal((await query("SELECT payload->>'revision' AS revision FROM application_reviews WHERE user_id=$1 AND id=$2",[owner,good.original.id]))[0].revision,result.application.revision,'old source imports cannot overwrite the correction');
  const concurrent=await fixture(),duplicates=await Promise.all([correctHeldReviewAnswers(concurrent.plan),correctHeldReviewAnswers(concurrent.plan)]);
  assert.deepEqual(duplicates.map(value=>value.alreadyCurrent).sort(),[false,true]);
  assert.equal((await query('SELECT count(*)::int AS n FROM application_review_operator_answer_revisions WHERE id=$1',[concurrent.plan.operationId]))[0].n,1);

  // Audit failure rolls back the answer update in the same transaction.
  const atomic=await fixture();
  await query(`CREATE FUNCTION reject_answer_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic audit unavailable';END$$;CREATE TRIGGER reject_answer_audit BEFORE INSERT ON application_review_operator_answer_revisions FOR EACH ROW EXECUTE FUNCTION reject_answer_audit()`);
  await assert.rejects(correctHeldReviewAnswers(atomic.plan),/Synthetic audit unavailable/);
  assert.equal((await query("SELECT payload->>'revision' AS revision FROM application_reviews WHERE user_id=$1 AND id=$2",[owner,atomic.original.id]))[0].revision,atomic.original.revision);
  await query('DROP TRIGGER reject_answer_audit ON application_review_operator_answer_revisions;DROP FUNCTION reject_answer_audit()');

  const planFile=resolve(directory,'correction-plan.json');writeFileSync(planFile,JSON.stringify({version:1,revisions:[good.plan]}));
  const cliUrl=new URL(String(pool.options.connectionString));cliUrl.searchParams.set('options',`-c search_path=${schema}`);
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../seek-bot/node_modules/tsx/dist/cli.mjs',import.meta.url)),fileURLToPath(new URL('../scripts/correct-held-review-answers.mts',import.meta.url)),planFile],{env:{...process.env,DATABASE_URL:cliUrl.href},encoding:'utf8',stdio:'pipe'});
  assert.match(output,/"alreadyCurrent":true/);assert.match(output,/"holdReleased":false/);assert.doesNotMatch(output,/Fictional Sheets|accurate reports/);

  // The owner row lock prevents a new run from becoming active during a correction.
  const race=await fixture(),originalConnect=pool.connect;
  let locked!:()=>void,resume!:()=>void;const userLocked=new Promise<void>(done=>{locked=done;}),continueCorrection=new Promise<void>(done=>{resume=done;});
  pool.connect=(async()=>{const client=await(originalConnect as unknown as ()=>Promise<pg.PoolClient>).call(pool),originalQuery=client.query,originalRelease=client.release;
    client.query=(async(sql:any,...params:any[])=>{const value=await(originalQuery as any).call(client,sql,...params);if(typeof sql==='string'&&sql.includes('ORDER BY id FOR UPDATE')){locked();await continueCorrection;}return value;}) as typeof client.query;
    client.release=(...args:any[])=>{client.query=originalQuery;client.release=originalRelease;(originalRelease as any).apply(client,args);};return client;}) as typeof pool.connect;
  const correction=correctHeldReviewAnswers(race.plan),starter=new pg.Client({connectionString:cliUrl.href});
  try{
    await userLocked;await starter.connect();await starter.query("SET statement_timeout='5s'");let inserted=false;
    const starting=starter.query('INSERT INTO run_starts VALUES(4,$1,now(),NULL)',[owner]).then(()=>{inserted=true;});
    await delay(40);assert.equal(inserted,false,'run registration waits behind the owner correction lock');
    resume();await correction;await starting;assert.equal(inserted,true);
  }finally{resume();await correction.catch(()=>{});pool.connect=originalConnect;await starter.end();await query('DELETE FROM run_starts WHERE id=4');}
  await releaseApplicationReviewHold(actor,owner,good.hold.id,{id:good.original.id,revision:good.original.revision},{id:good.original.id,revision:result.application.revision},`Human resolution: verified correction audit ${result.auditId}.`);
  await assert.rejects(claimApplicationReviews(owner,[{id:good.original.id,revision:good.original.revision}]),/no longer ready/);
  assert.equal((await claimApplicationReviews(owner,[{id:good.original.id,revision:result.application.revision}]))[0].revision,result.application.revision,'only a separate explicit candidate-confirmation path can approve the corrected version');
  console.log('PASS: isolated PostgreSQL exact held-answer CAS, active admin/owner/source/no-send guards, immutable before/after audit, rollback, idempotency/concurrency, active-run exclusion, old-import protection, hold preservation and closed CLI.');
}finally{
  await pool.end();if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  if(directoryCreated){assert.ok(directory.startsWith(resolve(USERS_DIR)+sep)&&directory.endsWith(sep+owner));rmSync(directory,{recursive:true,force:true});}
  if(previousAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=previousAdmins;
}
