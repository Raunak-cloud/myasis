import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getPool, query } from './db/index.js';
import { saveAnswers, AnswersValidationError } from './answers.js';
import { loadAttention } from './attention.js';
import { insertRunEventRow } from './db/records.js';
import { sealQuestionSnapshot } from '../../seek-bot/src/question-snapshot-node.js';

// Real independent database sessions, isolated in a freshly generated local
// schema. No production server, candidate account or existing table is used.
const pool=getPool();
const url=new URL(String(pool.options.connectionString));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Concurrency fixtures must use a local database.');
const schema=`attention_audit_${randomUUID().replaceAll('-','')}`;
assert.match(schema,/^attention_audit_[a-f0-9]{32}$/);
const admin=new pg.Client({connectionString:pool.options.connectionString});
let created=false;
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;
  pool.options.options=`-c search_path=${schema}`;pool.options.max=6;
  await query(`CREATE TABLE saved_answers(user_id BIGINT,question TEXT,answer TEXT,question_schema JSONB,answer_value JSONB,created_at TIMESTAMPTZ DEFAULT now(),UNIQUE(user_id,question));
    CREATE TABLE run_events(id BIGSERIAL,user_id BIGINT,job_id TEXT,status TEXT,title TEXT,company TEXT,reason TEXT,url TEXT,ts TIMESTAMPTZ DEFAULT clock_timestamp(),questions JSONB, account_access JSONB,dismissed_at TIMESTAMPTZ,
      review_disposition TEXT,review_listing_fingerprint TEXT,review_context_fingerprint TEXT,review_expires_at TIMESTAMPTZ,review_content_fingerprint TEXT,UNIQUE(user_id,job_id,status,ts));
    CREATE TABLE applications(user_id BIGINT,job_id TEXT);`);
  const snapshot=(job:string)=>sealQuestionSnapshot({version:2,source:{origin:'https://employer.test',path:`/jobs/${job}`},prompt:'Required choice',context:[],help:[],completeness:'complete',controls:[{id:'part0',label:'Required choice',kind:'radio',required:true,multiple:false,constraints:{},choices:[{id:'choice0',label:'First',value:'first',disabled:false},{id:'choice1',label:'Second',value:'second',disabled:false}]}]});
  const first=snapshot('double-save');
  await insertRunEventRow('1',{jobId:'double-save',status:'needs-human',questions:[{question:first.prompt,snapshot:first}],ts:new Date(Date.now()-60000)});
  const answer={questionId:first.id,revision:first.revision,response:{part0:'choice0'}};
  const saved=await Promise.all([saveAnswers('1',[answer],'double-save'),saveAnswers('1',[answer],'double-save')]);
  assert.deepEqual(saved,[{saved:1},{saved:1}]);
  assert.equal((await query(`SELECT * FROM run_events WHERE job_id='double-save' AND status='answered'`)).length,1,'simultaneous retries acknowledge one committed event');
  assert.equal((await loadAttention('1')).some(item=>item.jobId==='double-save'),false);

  // Opposite input orders for shared facts must acquire row locks in the
  // same order even though their application locks are different.
  for(let i=0;i<15;i++) {
    const a={question:'Shared first fixture fact',answer:`Answer ${i}`},b={question:'Shared second fixture fact',answer:`Answer ${i}`};
    await Promise.all([saveAnswers('1',[a,b],`order-a-${i}`),saveAnswers('1',[b,a],`order-b-${i}`)]);
  }

  for(let i=0;i<20;i++) {
    const job=`import-race-${i}`,old=snapshot(job);
    const updated=sealQuestionSnapshot({...old,controls:[{...old.controls[0],choices:[...old.controls[0].choices,{id:'choice2',label:'New choice',value:'new',disabled:false}]}]});
    await insertRunEventRow('1',{jobId:job,status:'needs-human',questions:[{question:old.prompt,snapshot:old}],ts:new Date(Date.now()-60000)});
    const saving=saveAnswers('1',[{questionId:old.id,revision:old.revision,response:{part0:'choice0'}}],job);
    const importing=insertRunEventRow('1',{jobId:job,status:'needs-human',questions:[{question:updated.prompt,snapshot:updated}],ts:new Date()});
    const outcomes=await Promise.allSettled(i%2?[saving,importing]:[importing,saving]);
    for(const outcome of outcomes)if(outcome.status==='rejected')assert.ok(outcome.reason instanceof AnswersValidationError,'only an explicitly rejected stale save is allowed');
    const pending=(await loadAttention('1')).find(item=>item.jobId===job);
    assert.equal(pending?.questions?.length,1);
    assert.equal(pending.questions[0].snapshot?.revision,updated.revision,'an older concurrent answer can never clear the new employer revision');
    assert.equal((await loadAttention('2')).length,0,'no event or fact escapes its owner');
  }
  console.log('PASS: independent sessions, duplicate saves, opposite fact orders and 20 import/save races; isolated local PostgreSQL schema only.');
}finally{
  await pool.end();
  if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
