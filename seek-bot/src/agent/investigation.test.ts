import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryRecord } from './recovery-record.js';
import { investigateApplicationState,investigationTool } from './investigation.js';
import { validToolInput } from './tool-input.js';
import { failedToolResult,type ToolContext } from './context.js';
import { rememberPrivateAuthenticationValue } from '../private-auth-fields.js';

test('read-only checks reject unobserved targets and cannot offer a mutating operation',()=>{
  const schema=investigationTool.parameters;
  assert.equal(validToolInput({check:'control',question:'Did it save?'},schema),false);
  assert.equal(validToolInput({check:'control',selector:'#phone',question:'Did it save?'},schema),true);
  assert.equal(validToolInput({check:'control',target_mode:'page',selector:'#phone',question:'Did it save?'},schema),false);
  assert.equal(validToolInput({check:'form',question:'Was it accepted?'},schema),true);
  assert.equal(validToolInput({check:'click',selector:'#send',question:'Test send again.'},schema),false);
  assert.equal(validToolInput({check:'form',question:'Inspect',script:'window.send()'},schema),false);
});

test('history checks see new source evidence independently of the page, without browser actions, model calls or leaking credentials',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'investigation-source-'));
  const record=new RecoveryRecord(directory,'main',{runId:'9',jobId:'posting',platform:'workday',mode:'prepare',contextHash:'candidate'},'attempt');
  const page={frames:()=>[]} as unknown as ToolContext['page'];
  const ctx={page,recoveryRecord:record,observation:{url:'https://fixture.invalid/apply',title:'Application',fields:[],actions:[],text:''}} as unknown as ToolContext;
  rememberPrivateAuthenticationValue(page,'PRIVATE_FIXTURE_SECRET');
  try {
    record.openUncertainty('submission','send','Was this application delivered?');
    let source='Send was attempted; no receipt exists yet. PRIVATE_FIXTURE_SECRET';
    const read=()=>source;
    const first=await investigateApplicationState(ctx,{check:'history',question:'Did it send?'},read);
    assert.equal(failedToolResult(first),false);assert.match(first.kind==='ok'?first.message:'',/no receipt exists yet/);
    assert.ok(!JSON.stringify(first).includes('PRIVATE_FIXTURE_SECRET'));
    const repeated=await investigateApplicationState(ctx,{check:'history',question:'Check again, different wording.'},read);
    assert.match(repeated.kind==='ok'?repeated.message:'',/UNCHANGED INVESTIGATION CHECK/);
    source='The owner-scoped record now includes a newly received employer acknowledgement.';
    const changed=await investigateApplicationState(ctx,{check:'history',question:'Did new evidence arrive?'},read);
    assert.match(changed.kind==='ok'?changed.message:'',/newly received employer acknowledgement/);
    assert.equal(record.snapshot().investigations?.[0].checks.length,2);
    assert.equal(record.snapshot().investigations?.[0].status,'investigating','a source read is evidence; it does not by itself establish acceptance');
    const original=record.snapshot().investigations![0].id;
    record.openUncertainty('authentication','reset','Reset acceptance is also uncertain.');
    await investigateApplicationState(ctx,{check:'history',question:'Check the original send, not the newer reset.',uncertainty_id:original},read);
    assert.equal(record.snapshot().investigations?.[1].checks.length,0,'an explicitly selected issue cannot consume another issue\'s allowance');
    const foreign=await investigateApplicationState(ctx,{check:'history',question:'Inspect another account.',uncertainty_id:'foreign-record'},()=>{throw Error('Must not read a foreign source');});
    assert.equal(foreign.kind==='ok'&&foreign.disposition,'invalid-arguments');
    assert.ok(!JSON.stringify(record.snapshot()).includes('PRIVATE_FIXTURE_SECRET'));
    assert.equal(record.snapshot().submissionAttempted,false);
  } finally {record.release();rmSync(directory,{recursive:true,force:true});}
});
