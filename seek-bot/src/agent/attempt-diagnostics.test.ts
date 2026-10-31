import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApplicationModel } from '../application-model.js';
import type { JobListing } from '../types.js';
import { bindAttemptCallback, currentAttempt, recordDiagnostic, recordToolDiagnostic, withApplicationAttempt } from './attempt-diagnostics.js';
import { persistLiveTrace, persistTrace } from './loop/trace.js';

test('preparation and confirmation retain separate steps; nested and stale errors remain correlated and redacted', async () => {
  const dir=mkdtempSync(join(tmpdir(),'attempt-audit-')), previous=process.env.DATA_DIR, priorRun=process.env.OWTOMATE_RUN_START_ID;
  const priorSecret=process.env.DIAGNOSTIC_TEST_TOKEN; process.env.DATA_DIR=dir;
  process.env.OWTOMATE_RUN_START_ID='123'; process.env.DIAGNOSTIC_TEST_TOKEN='private-test-secret';
  const job={id:'same-job',title:'Synthetic role',company:'Synthetic employer'} as JobListing;
  try {
    let callback=()=>{};
    const ids:string[]=[];
    await withApplicationAttempt(job, async()=>{
      ids.push(currentAttempt()!.attemptId);
      callback=bindAttemptCallback(()=>recordDiagnostic({severity:'warning',category:'page_runtime_error',stage:'browser',message:'Delayed page error'}));
      persistLiveTrace(job,[{step:1,url:'https://example.test',tool:'browser_batch',args:{},label:'Prepare',startedAt:new Date().toISOString()}]);
      recordToolDiagnostic(1,'browser_batch',JSON.stringify({results:[{index:0,kind:'ok'},{index:1,error:'Ambiguous label token=private-test-secret contact person@example.test',evidence:'DO NOT COPY RAW FORM'}]}),'failed');
      persistTrace(job,{status:'prepared'} as any,[{step:1,url:'https://example.test',tool:'prepare_application',args:{},label:'Prepared',result:'Prepared'}],'https://example.test');
      return {outcome:{status:'prepared'}};
    });
    callback();
    await withApplicationAttempt(job,async()=>{
      ids.push(currentAttempt()!.attemptId);
      recordToolDiagnostic(2,'browser_action','Observed ref a3 is no longer on the page. No action was attempted.','reobserve');
      recordToolDiagnostic(3,'browser_action','The browser action completed, but its follow-up wait timed out.');
      recordToolDiagnostic(4,'browser_action','Action executed.');
      recordToolDiagnostic(5,'wait_for_submission_result','Read the fresh employer response. This wait did not repeat the send.','reobserve');
      recordToolDiagnostic(6,'enter_emailed_code','Supply the current code targets. No action ran.','invalid-arguments');
      persistTrace(job,{status:'applied'},[{step:2,url:'https://example.test',tool:'finish',args:{},label:'Submitted'}],'https://example.test');
      return {outcome:{status:'applied'}};
    });
    assert.notEqual(ids[0],ids[1]);
    const archives=readdirSync(join(dir,'traces')).filter(f=>/^attempt-/.test(f)).map(f=>JSON.parse(readFileSync(join(dir,'traces',f),'utf8')));
    assert.equal(archives.length,2); assert.deepEqual(new Set(archives.map(t=>t.outcome.status)),new Set(['prepared','applied']));
    const raw=readFileSync(join(dir,'traces','run-123.diagnostics.jsonl'),'utf8');
    assert.doesNotMatch(raw,/private-test-secret|person@example.test|DO NOT COPY RAW FORM/);
    const events=raw.trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(events.find(e=>e.category==='tool_error').batchIndex,1);
    assert.equal(events.find(e=>e.category==='stale_target').step,2);
    assert.equal(events.filter(e=>e.category==='wait_warning').length,1);
    assert.equal(events.find(e=>e.category==='page_runtime_error').attemptId,ids[0]);
    assert.equal(events.find(e=>e.category==='tool_handoff').severity,'info');
    const invalid=events.find(e=>e.tool==='enter_emailed_code');
    assert.equal(invalid.category,'tool_error');assert.equal(invalid.severity,'warning');assert.equal(invalid.disposition,'invalid-arguments');
    assert.ok(events.every(e=>e.runStartId==='123'));
  }finally{
    if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;
    if(priorRun===undefined)delete process.env.OWTOMATE_RUN_START_ID;else process.env.OWTOMATE_RUN_START_ID=priorRun;
    if(priorSecret===undefined)delete process.env.DIAGNOSTIC_TEST_TOKEN;else process.env.DIAGNOSTIC_TEST_TOKEN=priorSecret;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('disk logging failure never replaces successful application outcome or its real exception', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'audit-io-')),old=process.env.DATA_DIR; const warn=console.warn;
 writeFileSync(join(dir,'not-directory'),'blocked');process.env.DATA_DIR=join(dir,'not-directory');let warnings=0;
 console.warn=()=>{warnings++;};
 try {
  const job={id:'io',title:'Synthetic',company:'Synthetic'};
  const value=await withApplicationAttempt(job,async()=>({outcome:{status:'applied'}}));
  assert.equal(value.outcome.status,'applied');
  const original=new Error('Actual provider failure');
  await assert.rejects(withApplicationAttempt(job,async()=>{throw original;}),error=>error===original);
  assert.ok(warnings>0);
 }finally{console.warn=warn;if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test('parallel owners and delayed browser callbacks retain the originating account',async()=>{
 const dirs=[mkdtempSync(join(tmpdir(),'audit-owner-a-')),mkdtempSync(join(tmpdir(),'audit-owner-b-'))];
 const callbacks:Array<()=>void>=[];
 try {
  await Promise.all(dirs.map((dir,i)=>withApplicationModel({DATA_DIR:dir,OWTOMATE_RUN_START_ID:String(200+i)},()=>
   withApplicationAttempt({id:'same',title:'Synthetic',company:'Synthetic'},async()=>{
    callbacks[i]=bindAttemptCallback(()=>recordToolDiagnostic(1,'browser_action','Observed ref a2 is no longer on the page.','reobserve'));
    await Promise.resolve();return {outcome:{status:'prepared'}};
   }))));
  callbacks.forEach(fn=>fn());
  for(const [i,dir] of dirs.entries()){
   const files=readdirSync(join(dir,'traces'));assert.deepEqual(files,[`run-${200+i}.diagnostics.jsonl`]);
   const events=readFileSync(join(dir,'traces',files[0]),'utf8').trim().split('\n').map(l=>JSON.parse(l));
   assert.ok(events.every(e=>e.runStartId===String(200+i)));assert.equal(new Set(events.map(e=>e.attemptId)).size,1);
  }
 }finally{dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true}));}
});
