import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {getPool,query} from './db/index.js';
import {userDir,USERS_DIR} from './userdata.js';
import {documentRestorationPlan,restoreReviewDocument,type ReviewDocumentRestorationPlan} from './application-review-document-restore.js';
import {holdApplicationReview,claimApplicationReviews,editApplicationCoverLetter} from './application-reviews.js';
import {applicationRevision} from '../../seek-bot/src/application-review-content.js';
import {documentHash,verifiedDocumentPath} from '../../seek-bot/src/application-documents.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

const pool=getPool(),url=new URL(String(pool.options.connectionString));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Restoration tests require isolated local PostgreSQL.');
const schema=`document_restore_${randomUUID().replaceAll('-','')}`;
assert.match(schema,/^document_restore_[a-f0-9]{32}$/);
const owner=`8${Date.now()}`,other=String(BigInt(owner)+1n),actor=String(BigInt(owner)+2n),outsider=String(BigInt(owner)+3n);
const directory=resolve(userDir(owner));
assert.ok(directory.startsWith(resolve(USERS_DIR)+sep)&&directory.endsWith(sep+owner)&&!existsSync(directory));
const previousAdmins=process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS='operator@restore.fixture.invalid';
const admin=new pg.Client({connectionString:pool.options.connectionString});
const letter='Fictional original cover letter.\n\nFull wording, punctuation and line breaks remain unchanged.\n';
const filename='Original Letter.txt',knowledgePath=resolve(directory,'knowledge',filename);
const started=new Date(Date.now()-120_000),finished=new Date(Date.now()-1000);
let schemaCreated=false,directoryCreated=false,number=0;
const journal:string[]=[];
async function fixture(options:{coverLetter?:string;status?:string;credit?:boolean;retainedFilename?:boolean;nullReadback?:boolean}={}){
  const job=String(++number),preparedAt=new Date(Date.now()-60_000).toISOString(),attemptId=randomUUID();
  const original:PreparedApplication={id:randomUUID(),revision:'',job:{id:job,title:'Fictional analyst',company:'Fixture',platform:'seek',location:'Sydney',url:`https://fixture.invalid/job/${job}`},
    formUrl:`https://fixture.invalid/job/${job}/apply/review`,preparedAt,answers:[{question:'Fictional known fact',answer:'Unchanged answer'},...(options.retainedFilename?[{question:'Document filename retained in original review',answer:filename}]:[])],resumeId:'resume-fixture',resume:'CV.txt',resumeHash:'1'.repeat(64),
    ...(options.coverLetter?{coverLetter:options.coverLetter}:{})};
  original.revision=applicationRevision(original);
  await query('INSERT INTO application_reviews(user_id,job_key,id,payload,status,credit_consumed) VALUES($1,$2,$3,$4,$5,$6)',
    [owner,`seek:${job}`,original.id,JSON.stringify(original),'ready',options.credit??true]);
  journal.push(JSON.stringify({ts:preparedAt,status:'prepared',draft:original}));writeFileSync(resolve(directory,'run-log.jsonl'),journal.join('\n')+'\n');
  const completedAt=new Date(Date.parse(preparedAt)-1000).toISOString();
  const trace={runStartId:'1',attemptId,jobId:job,job:original.job,startedAt:new Date(Date.parse(preparedAt)-5000).toISOString(),savedAt:preparedAt,
    outcome:{status:'prepared',draft:original},sendAudit:{attempted:false},steps:[{step:1,tool:number%2===0?'browser_upload':'browser_action',args:{...number%2===0?{}:{action:'set_input_files'},file_ids:['supporting:1']},
      execution:'started',completedAt,result:JSON.stringify({action:'set_input_files',file_ids:['supporting:1'],current:options.nullReadback?null:{files:[filename],invalid:false,validation:''}})}]};
  const tracePath=resolve(directory,'traces',`attempt-${attemptId}.json`);writeFileSync(tracePath,JSON.stringify(trace));
  const hold=await holdApplicationReview(actor,owner,{id:original.id,revision:original.revision},'Investigate missing metadata.','1');
  if(options.status)await query('UPDATE application_reviews SET status=$3 WHERE user_id=$1 AND id=$2',[owner,original.id,options.status]);
  const plan:ReviewDocumentRestorationPlan={actorUserId:actor,userId:owner,draftId:original.id,currentRevision:original.revision,originalRevision:original.revision,
    holdId:hold.id,sourceRunId:'1',attemptId,fileId:'supporting:1',expectedSha256:documentHash(Buffer.from(letter)),reason:'Operator verified the original native upload; restore only its missing letter metadata.'};
  return{original,trace,tracePath,plan,hold};
}
await admin.connect();
try{
  await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;pool.options.options=`-c search_path=${schema}`;
  await query('CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);CREATE TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT,started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ);CREATE TABLE knowledge_items(id BIGINT PRIMARY KEY,user_id BIGINT,kind TEXT,file_name TEXT,enabled BOOLEAN);');
  await query('INSERT INTO users VALUES($1,$2,NULL),($3,$4,NULL),($5,$6,NULL),($7,$8,NULL)',[owner,'owner@restore.fixture.invalid',other,'other@restore.fixture.invalid',actor,'operator@restore.fixture.invalid',outsider,'nonadmin@restore.fixture.invalid']);
  await query('INSERT INTO run_starts VALUES(1,$1,$2,$3),(2,$4,$2,$3)',[owner,started,finished,other]);
  await query('INSERT INTO knowledge_items VALUES(1,$1,\'file\',$2,true),(2,$3,\'file\',$2,true)',[owner,filename,other]);
  const sql=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
  for(const table of ['application_reviews','application_review_operator_holds']){
    const statement=sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];assert.ok(statement);await query(statement);
  }
  await query('CREATE UNIQUE INDEX application_review_one_active_hold_idx ON application_review_operator_holds(user_id,job_key) WHERE released_at IS NULL');
  mkdirSync(directory);directoryCreated=true;mkdirSync(resolve(directory,'knowledge'));mkdirSync(resolve(directory,'traces'));writeFileSync(knowledgePath,letter);

  const good=await fixture();
  for(const extra of [{path:'arbitrary'},{text:'arbitrary'},{command:'arbitrary'},{release:true}])assert.throws(()=>documentRestorationPlan({...good.plan,...extra}),/closed/);
  await assert.rejects(restoreReviewDocument({...good.plan,actorUserId:outsider}),/active administrator/);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1',[actor]);await assert.rejects(restoreReviewDocument(good.plan),/active administrator/);await query('UPDATE users SET blocked_at=NULL WHERE id=$1',[actor]);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1',[owner]);await assert.rejects(restoreReviewDocument(good.plan),/owner.*blocked/);await query('UPDATE users SET blocked_at=NULL WHERE id=$1',[owner]);
  await assert.rejects(restoreReviewDocument({...good.plan,userId:other}),/not ready/);
  await assert.rejects(restoreReviewDocument({...good.plan,fileId:'supporting:2'}),/belonging to this owner/);
  await assert.rejects(restoreReviewDocument({...good.plan,sourceRunId:'2'}),/original operator hold/);
  await assert.rejects(restoreReviewDocument({...good.plan,expectedSha256:'f'.repeat(64)}),/hash changed/);
  await assert.rejects(restoreReviewDocument({...good.plan,currentRevision:'f'.repeat(64)}),/revision changed/);
  for(const status of ['approved','applied','failed']){const item=await fixture({status});await assert.rejects(restoreReviewDocument(item.plan),/not ready/);}
  const uncredited=await fixture({credit:false});await assert.rejects(restoreReviewDocument(uncredited.plan),/credited review/);
  const existing=await fixture({coverLetter:'Already reviewed text'});await assert.rejects(restoreReviewDocument(existing.plan),/never overwrite/);
  const noNative=await fixture();noNative.trace.steps[0].result=JSON.stringify({action:'set_input_files',file_ids:['supporting:1'],current:{files:[]}});writeFileSync(noNative.tracePath,JSON.stringify(noNative.trace));
  await assert.rejects(restoreReviewDocument(noNative.plan),/No completed native upload/);
  const wrongName=await fixture();wrongName.trace.steps[0].result=JSON.stringify({action:'set_input_files',file_ids:['supporting:1'],current:{files:['Other.txt']}});writeFileSync(wrongName.tracePath,JSON.stringify(wrongName.trace));
  await assert.rejects(restoreReviewDocument(wrongName.plan),/No completed native upload/);
  const missingReadback=await fixture({retainedFilename:true,nullReadback:true});
  const unavailable=await restoreReviewDocument(missingReadback.plan);
  assert.equal(unavailable.application.documents![0].requiresUpload,true,'unavailable native readback creates mandatory future delivery, never assumed retention');
  const unavailableAudit=unavailable.application.documentRestorations![0].evidence;
  assert.equal(unavailableAudit.nativeReadback,'unavailable');assert.equal(unavailableAudit.selectionCompleted,true);assert.equal(unavailableAudit.employerRetention,'unverified');
  assert.equal((await restoreReviewDocument(missingReadback.plan)).alreadyCurrent,true);
  const noFilenameEvidence=await fixture({nullReadback:true});await assert.rejects(restoreReviewDocument(noFilenameEvidence.plan),/No completed native upload/);
  const failedNative=await fixture();failedNative.trace.steps[0].result=JSON.stringify({action:'set_input_files',file_ids:['supporting:1'],current:null});failedNative.trace.steps[0].execution='not-started';writeFileSync(failedNative.tracePath,JSON.stringify(failedNative.trace));
  await assert.rejects(restoreReviewDocument(failedNative.plan),/No completed native upload/);
  const foreignTrace=await fixture();foreignTrace.trace.runStartId='2';writeFileSync(foreignTrace.tracePath,JSON.stringify(foreignTrace.trace));
  await assert.rejects(restoreReviewDocument(foreignTrace.plan),/exact original draft/);
  const tampered=await fixture();const changedPayload={...tampered.original,answers:[{question:'Fictional known fact',answer:'Changed without revision'}]};
  await query('UPDATE application_reviews SET payload=$3 WHERE user_id=$1 AND id=$2',[owner,tampered.original.id,JSON.stringify(changedPayload)]);
  await assert.rejects(restoreReviewDocument(tampered.plan),/revision integrity/);
  const changed=await fixture();const changedVersion={...changed.original,answers:[{question:'Fictional known fact',answer:'Legitimately different version'}]};changedVersion.revision=applicationRevision(changedVersion);
  await query('UPDATE application_reviews SET payload=$3 WHERE user_id=$1 AND id=$2',[owner,changed.original.id,JSON.stringify(changedVersion)]);
  await assert.rejects(restoreReviewDocument({...changed.plan,currentRevision:changedVersion.revision}),/unchanged original/);
  const sourceTampered=await fixture();sourceTampered.trace.outcome.draft.answers=[{question:'Fictional known fact',answer:'Corrupt original evidence'}];writeFileSync(sourceTampered.tracePath,JSON.stringify(sourceTampered.trace));
  await assert.rejects(restoreReviewDocument(sourceTampered.plan),/revision integrity/);
  const blank=await fixture();writeFileSync(knowledgePath,' \n ');await assert.rejects(restoreReviewDocument({...blank.plan,expectedSha256:documentHash(Buffer.from(' \n '))}),/no readable full text/);writeFileSync(knowledgePath,letter);
  const unsafePath=await fixture();await query('UPDATE knowledge_items SET file_name=$1 WHERE id=1',['../foreign.txt']);await assert.rejects(restoreReviewDocument(unsafePath.plan),/enabled supporting file/);await query('UPDATE knowledge_items SET file_name=$1 WHERE id=1',[filename]);
  await query('UPDATE knowledge_items SET enabled=false WHERE id=1');await assert.rejects(restoreReviewDocument(good.plan),/enabled supporting file/);await query('UPDATE knowledge_items SET enabled=true WHERE id=1');

  // Working journals are volatile; no historical event is rewritten to repair them.
  writeFileSync(resolve(directory,'run-log.jsonl'),JSON.stringify({status:'started',ts:new Date().toISOString(),runId:'later-run'})+'\n');
  const journalBefore=readFileSync(resolve(directory,'run-log.jsonl'),'utf8'),traceBefore=readFileSync(good.tracePath,'utf8');
  const restored=await restoreReviewDocument(good.plan);
  assert.equal(restored.alreadyCurrent,false);assert.equal(restored.application.id,good.original.id);assert.equal(restored.application.preparedAt,good.original.preparedAt);
  assert.notEqual(restored.application.revision,good.original.revision);assert.equal(restored.application.coverLetter,letter);assert.deepEqual(restored.application.answers,good.original.answers);
  assert.deepEqual(restored.application.job,good.original.job);assert.equal(restored.application.resumeHash,good.original.resumeHash);assert.equal(restored.application.resumeId,good.original.resumeId);
  const document=restored.application.documents![0];assert.equal(document.role,'cover-letter');assert.equal(document.provenance,'file');assert.equal(document.text,letter);
  assert.equal(readFileSync(verifiedDocumentPath(document,directory),'utf8'),letter);
  const audit=restored.application.documentRestorations![0];assert.equal(audit.actorUserId,actor);assert.equal(audit.holdId,good.hold.id);assert.equal(audit.originalRevision,good.original.revision);assert.equal(audit.currentRevision,restored.application.revision);
  assert.ok(Date.parse(audit.restoredAt)>Date.parse(good.original.preparedAt));assert.equal(audit.evidence.attemptId,good.plan.attemptId);
  assert.equal(readFileSync(resolve(directory,'run-log.jsonl'),'utf8'),journalBefore);assert.equal(readFileSync(good.tracePath,'utf8'),traceBefore);
  assert.equal((await restoreReviewDocument(good.plan)).alreadyCurrent,true);assert.equal((await restoreReviewDocument(good.plan)).application.documentRestorations!.length,1);
  const row=(await query('SELECT status,credit_consumed,updated_at FROM application_reviews WHERE user_id=$1 AND id=$2',[owner,good.original.id]))[0];assert.equal(row.status,'ready');assert.equal(row.credit_consumed,true);assert.ok(+new Date(row.updated_at)>Date.parse(good.original.preparedAt));
  assert.equal((await query('SELECT released_at FROM application_review_operator_holds WHERE id=$1',[good.hold.id]))[0].released_at,null);
  await assert.rejects(claimApplicationReviews(owner,[{id:good.original.id,revision:restored.application.revision}]),/no longer ready/);
  await assert.rejects(editApplicationCoverLetter(owner,{id:good.original.id,revision:restored.application.revision},'Concurrent candidate edit'),/no longer editable/);
  const concurrent=await fixture();const duplicates=await Promise.all([restoreReviewDocument(concurrent.plan),restoreReviewDocument(concurrent.plan)]);
  assert.deepEqual(duplicates.map(x=>x.alreadyCurrent).sort(),[false,true]);assert.equal(duplicates[0].application.revision,duplicates[1].application.revision);
  const planFile=resolve(directory,'restore-plan.json');writeFileSync(planFile,JSON.stringify({version:1,restorations:[good.plan]}));
  const cliUrl=new URL(String(pool.options.connectionString));cliUrl.searchParams.set('options',`-c search_path=${schema}`);
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../seek-bot/node_modules/tsx/dist/cli.mjs',import.meta.url)),
    fileURLToPath(new URL('../scripts/restore-review-document.mts',import.meta.url)),planFile],{env:{...process.env,DATABASE_URL:cliUrl.href},encoding:'utf8',stdio:'pipe'});
  assert.match(output,/"alreadyCurrent":true/);assert.match(output,/"holdReleased":false/);assert.doesNotMatch(output,/Fictional original cover letter/);
  console.log('PASS: local PostgreSQL held-review restoration, immutable native proof, rotated journal, owner/admin/hash/text/status guards, no credits/history changes, hold-preserving idempotency/concurrency and closed CLI.');
}finally{
  await pool.end();if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  if(directoryCreated){assert.ok(directory.startsWith(resolve(USERS_DIR)+sep)&&directory.endsWith(sep+owner));rmSync(directory,{recursive:true,force:true});}
  if(previousAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=previousAdmins;
}
