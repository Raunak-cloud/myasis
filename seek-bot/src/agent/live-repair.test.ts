import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverDuringRun, readLiveRepairTicket, type RepairContinuation } from './live-repair.js';
import type { AgentRunOptions,AgentRunResult } from './loop.js';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const caseId='00000000-0000-4000-8000-000000000001',attemptId='00000000-0000-4000-8000-000000000002';
const checkpoint={attemptId,runId:'100',page:{isClosed:()=>false},meter:{totals:{costUsd:.08}},captured:[{question:'Name',answer:'Fixture'}],files:[],actions:[]} as unknown as RepairContinuation;
const original={outcome:{status:'skipped',reason:'Paused for repair'},captured:checkpoint.captured,actions:[],submitPressed:false,steps:3,usage:'fixture',repair:checkpoint} as AgentRunResult;
const options={page:checkpoint.page,job:{id:'fixture'},profile:{}} as AgentRunOptions;
test('cooperative recovery keeps the current run, page, answers and exact spending meter; resumes at most once',async()=>{
  let now=0,resumes=0;const events:string[]=[];
  const result=await recoverDuringRun(options,original,{enabled:()=>true,now:()=>now,sleep:async()=>{now+=1000;},safe:()=>true,
    ticket:()=>now<1000?null:{status:'in_run_ready',caseId,runId:'100',attemptId,expiresAt:Date.now()+10000},event:name=>events.push(name),
    load:async()=>async next=>{
      resumes++;assert.equal(next.page,checkpoint.page);assert.equal(next.continuation?.meter,checkpoint.meter);
      assert.equal(next.continuation?.captured,checkpoint.captured);assert.equal(next.job,options.job);
      return {...original,repair:undefined,outcome:{status:'prepared',draft:{} as never},steps:2};
    }});
  assert.equal(resumes,1);assert.equal(result.outcome.status,'prepared');assert.equal(result.steps,5);assert.equal(result.repair,undefined);
  assert.deepEqual(events,['repair_waiting','repair_resumed','repair_completed']);
});
test('paused/unsafe/sent/closed/expired recovery never invokes a continuation',async()=>{
  for(const scenario of ['paused','unsafe','sent','closed','expired','blocked'] as const){
    let now=0,resumes=0;
    const start={...original,submitPressed:scenario==='sent',repair:{...checkpoint,page:{isClosed:()=>scenario==='closed'}} as RepairContinuation};
    const result=await recoverDuringRun(options,start,{enabled:()=>scenario!=='paused',safe:()=>scenario!=='unsafe',now:()=>now,
      sleep:async()=>{now+=400000;},ticket:()=>scenario==='blocked'?{status:'blocked',caseId,runId:'100',attemptId,expiresAt:Date.now()+1000}:null,
      event:()=>{},load:async()=>async()=>{resumes++;return original;}});
    assert.equal(resumes,0,scenario);assert.equal(result.outcome.status,'skipped');
  }
});
test('a resumed-agent exception propagates instead of falsely returning the old unsent state',async()=>{
  await assert.rejects(()=>recoverDuringRun(options,original,{enabled:()=>true,safe:()=>true,event:()=>{},ticket:()=>({status:'in_run_ready',caseId,runId:'100',attemptId,expiresAt:Date.now()+1000}),load:async()=>async()=>{throw Error('send state uncertain');}}),/uncertain/);
});
test('tickets bind the original run/attempt and reject expired or mismatched capabilities',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'repair-ticket-'));
  try{mkdirSync(resolve(root,'tickets'));
    const file=resolve(root,'tickets',`100-${attemptId}.json`),valid={status:'in_run_ready',caseId,runId:'100',attemptId,expiresAt:Date.now()+10000};
    writeFileSync(file,JSON.stringify(valid));assert.equal(readLiveRepairTicket('100',attemptId,root,false)?.caseId,caseId);
    for(const patch of [{runId:'101'},{attemptId:caseId},{expiresAt:0},{caseId:'../foreign'}]){writeFileSync(file,JSON.stringify({...valid,...patch}));assert.throws(()=>readLiveRepairTicket('100',attemptId,root,false));}
  }finally{rmSync(root,{recursive:true,force:true});}
});
