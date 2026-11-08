import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { RecoveryRecord, type RecoveryScope, type RecoveryWork } from './recovery-record.js';
import { RecoveryCheckpoint } from './recovery-checkpoint.js';
import { ApplicationTurnCoordinator } from './application-turn.js';

const directories: string[] = [];
const directory = () => { const value=mkdtempSync(join(tmpdir(),'shared-recovery-'));directories.push(value);return value; };
after(()=>directories.forEach(value=>rmSync(value,{recursive:true,force:true})));
const scope: RecoveryScope = {runId:'42',jobId:'job-one',platform:'workday',mode:'prepare',contextHash:'candidate-and-approval-hash'};
const work: RecoveryWork = {captured:[{question:'Name',answer:'Fixture Candidate'}],actions:[],files:[],resumeUsed:'cv',coverLetter:'Exact letter with https://portfolio.example.invalid/a-very-long-project-identifier?version=1#work'};

test('tested helper results share the durable record without clearing their enclosing mutation guard',()=>{
  const record=new RecoveryRecord(directory(),'main',scope,'helper-attempt');
  record.checkpoint(work,{});
  assert.throws(()=>record.recordHelperResult('browser_action','fill','filled','completed',work,{}),/active parent operation/);
  const id=record.begin('helper_fixture_1234',undefined,true);
  record.recordHelperResult('browser_action','fill','Actual current value: Fixture Candidate','completed',work,{helperStep:1});
  assert.equal(record.snapshot().pending?.id,id);
  assert.equal(record.snapshot().pending?.mutating,true);
  assert.match(JSON.stringify(record.evidenceHistory()),/Actual current value/);
  assert.deepEqual(record.snapshot().work,work);
  record.complete(id,'Helper finished','completed',work,false);
  assert.equal(record.snapshot().pending,undefined);
  assert.equal(record.evidenceHistory().length,2);
  record.finish('finished');record.release();
});

test('completed work, counters, actual evidence and consultation allowance survive a handoff without replay',()=>{
  const dir=directory(); let record=new RecoveryRecord(dir,'main',scope,'attempt');
  const recovery=new RecoveryCheckpoint(),turn=new ApplicationTurnCoordinator();
  recovery.failed('browser_action',{action:'fill',selector:'#phone'},'https://employer.invalid/form','Phone requires international format');
  recovery.remember('Agent hypothesis: uploaded file was missing.');
  turn.executed('browser_action');
  record.checkpoint(work,{recovery:recovery.checkpoint(),turn:turn.checkpoint(),budget:{spentUsd:.21}}, {url:'https://employer.invalid/form',title:'Application',fields:[]});
  const id=record.begin('browser_action','set_input_files',true);
  record.complete(id,JSON.stringify({current:{label:'Resume',files:['Candidate CV.pdf']}}),'completed',work,false);
  const ticket=record.reserveAdvice()!;assert.equal(record.acceptAdvice(ticket,'key','Inspect only the missing phone number.'),true);
  const saved=record.snapshot(); record.finish('paused');record.release();
  record=new RecoveryRecord(dir,'main',scope,'attempt',undefined,true);
  assert.deepEqual(record.snapshot().work,work,'candidate content is exact, including portfolio links');
  assert.equal(record.snapshot().consultation.calls,1);
  assert.equal(record.snapshot().pending,undefined);
  assert.ok(record.snapshot().revision>saved.revision);
  const restored=new RecoveryCheckpoint();restored.restore(record.snapshot().controls!.recovery as ReturnType<RecoveryCheckpoint['checkpoint']>);
  assert.match(restored.render(),/Phone requires international format/);
  const restoredTurn=new ApplicationTurnCoordinator();restoredTurn.restore(record.snapshot().controls!.turn as ReturnType<ApplicationTurnCoordinator['checkpoint']>);
  assert.deepEqual(restoredTurn.checkpoint(),turn.checkpoint());
  const view=JSON.stringify(record.view());assert.match(view,/Candidate CV.pdf/);assert.match(view,/Agent hypothesis/);
  assert.match(view,/"browserWriter":"applying-agent-only"/);assert.match(view,/"candidateConfirmationRequired":true/);
  assert.ok(record.reserveAdvice());assert.equal(record.reserveAdvice(),undefined);
  record.finish('finished');record.release();
  assert.throws(()=>new RecoveryRecord(dir,'main',scope,'attempt',undefined,true),/does not match/);
});

test('stale specialist and tool results cannot overwrite newer state or mint another consultation',()=>{
  const record=new RecoveryRecord(directory(),'main',scope,'attempt');
  try {
    record.checkpoint(work,{});
    const ticket=record.reserveAdvice()!;
    assert.equal(record.reserveAdvice(),undefined,'a second consultation cannot race the first');
    const id=record.begin('browser_action','fill',true);
    assert.throws(()=>record.begin('browser_action','click',true),/still pending/);
    assert.throws(()=>record.complete('stale-id','old response','completed',work,false),/stale operation/);
    const newer={...work,captured:[...work.captured,{question:'City',answer:'Sydney'}]};
    record.complete(id,'Actual saved City: Sydney','completed',newer,false);
    assert.equal(record.acceptAdvice(ticket,'old','Erase the completed city.'),false);
    assert.equal(record.snapshot().consultation.advice,undefined);
    assert.deepEqual(record.snapshot().work,newer);
    assert.equal(record.snapshot().consultation.calls,1);
    const latest=record.reserveAdvice()!;assert.equal(record.acceptAdvice(latest,'new','Retain the city.'),true);
    assert.equal(record.acceptAdvice(ticket,'old','Late reply'),false);
    assert.equal(record.snapshot().consultation.advice?.key,'new');
    record.release();record.cancelAdvice(latest);assert.equal(record.acceptAdvice(latest,'too-late','Late reply'),false);assert.throws(()=>record.snapshot(),/no longer owns/);
  } finally { record.release(); }
});

test('owner, run, job, mode and candidate/approval boundaries reject unrelated continuations',()=>{
  const dir=directory(),record=new RecoveryRecord(dir,'main',scope,'attempt');record.checkpoint(work,{});record.release();
  for(const changed of [{runId:'43'},{jobId:'another'},{platform:'lever'},{mode:'auto'},{contextHash:'changed-approval'}])
    assert.throws(()=>new RecoveryRecord(dir,'main',{...scope,...changed},'attempt',undefined,true),/does not match/);
  assert.throws(()=>new RecoveryRecord(directory(),'main',scope,'attempt',undefined,true),/no matching recovery record/);
  const independent=new RecoveryRecord(dir,'indeed',{...scope,jobId:'independent'},'independent');independent.release();
});

test('credentials/reset URLs stay out of durable evidence; exact candidate documents and private file references remain recoverable',()=>{
  const dir=directory(),secret='fixture-secret-password';
  const redact=(value:unknown):unknown=>JSON.parse(JSON.stringify(value).replaceAll(secret,'[private credential]'));
  const record=new RecoveryRecord(dir,'main',scope,'attempt',redact);
  try {
    record.checkpoint({...work,files:[{id:'generated:letter',path:'C:/owner/private-letter.txt',text:work.coverLetter}]},
      {recovery:{note:`Do not expose ${secret}`}}, {url:'https://employer.invalid/reset/123456789012345678901234567890?token=private-token#secret',password:secret,text:secret});
    const id=record.begin('fill_authentication_fields',undefined,true);
    record.complete(id,`Reset opened https://employer.invalid/reset?code=private-code; password ${secret}`,'completed',work,false);
    const state=JSON.stringify(record.snapshot());assert.ok(!state.includes(secret));assert.ok(!state.includes('private-token'));assert.ok(!state.includes('private-code'));assert.ok(!state.includes('123456789012345678901234567890'));
    assert.equal(record.snapshot().work?.coverLetter,work.coverLetter);
    assert.ok(!JSON.stringify(record.view()).includes('C:/owner/private-letter.txt'));
  } finally {record.release();}
  assert.ok(!readFileSync(join(dir,'application-recovery.sqlite')).includes(Buffer.from(secret)));
});

test('a separate process cannot steal a live writer, even for a different run',async()=>{
  const dir=directory(),module=new URL('./recovery-record.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {RecoveryRecord} from ${JSON.stringify(module)};new RecoveryRecord(${JSON.stringify(dir)},'main',${JSON.stringify(scope)},'child');process.stdout.write('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout,'data');
    assert.throws(()=>new RecoveryRecord(dir,'main',{...scope,runId:'43'},'parent'),/active writer/);
    assert.throws(()=>new RecoveryRecord(dir,'seek',scope,'child',undefined,true),/active writer/,'same record cannot acquire a competing writer through another lane');
    const other=new RecoveryRecord(dir,'indeed',{...scope,jobId:'other-worker'},'other');other.release();
  } finally {child.kill();await once(child,'exit');}
  const reclaimed=new RecoveryRecord(dir,'main',scope,'child',undefined,true);reclaimed.release();
});

test('bounded prompt windows do not discard earlier actual tool evidence',()=>{
  const record=new RecoveryRecord(directory(),'main',scope,'attempt');
  try {
    for(let index=0;index<20;index++){
      const op=record.begin('browser_action','inspect',false);
      record.complete(op,`Actual saved field ${index}: ${'e'.repeat(5000)}`,'completed',work,false);
    }
    assert.equal(record.snapshot().evidence.length,16);
    assert.equal(record.evidenceHistory().length,20);
    assert.match(record.evidenceHistory()[0].result,/Actual saved field 0/);
    assert.ok(record.evidenceHistory()[0].result.length>5000,'retained evidence is complete');
  } finally {record.release();}
});

test('crash recovery refuses unknown mutations/sends and clears interrupted reads without replay',()=>{
  const module=new URL('./recovery-record.js',import.meta.url).href;
  for(const variant of ['mutation','send','read'] as const){
    const dir=directory();
    const script=`import {RecoveryRecord} from ${JSON.stringify(module)};const r=new RecoveryRecord(${JSON.stringify(dir)},'main',${JSON.stringify(scope)},'child');r.checkpoint(${JSON.stringify(work)},{},undefined,${variant==='send'});r.reserveAdvice();r.begin('browser_action',${JSON.stringify(variant==='read'?'inspect':'click')},${variant==='mutation'});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
    if(variant!=='read'){
      assert.throws(()=>new RecoveryRecord(dir,'main',scope,'child',undefined,true),/uncertain outcome/);
      const db=new DatabaseSync(join(dir,'application-recovery.sqlite'),{readOnly:true});
      try{const saved=JSON.parse(String(db.prepare('SELECT state FROM recovery_records WHERE id=?').get('child')!.state));
        assert.equal(saved.investigations[0].status,'investigating','a blocked replay preserves an explicit investigation, not a failure verdict');
        assert.equal(saved.pending.tool,'browser_action');
      }finally{db.close();}
    }
    else {
      const resumed=new RecoveryRecord(dir,'main',scope,'child',undefined,true);
      assert.equal(resumed.snapshot().pending,undefined);assert.equal(resumed.snapshot().consultation.pending,undefined);
      assert.equal(resumed.snapshot().consultation.calls,1,'crashed paid request retains its allowance');
      assert.deepEqual(resumed.snapshot().work,work);resumed.release();
    }
  }
});

test('investigation reads, deduplication and limits persist without granting action or acceptance',()=>{
  const dir=directory();let record=new RecoveryRecord(dir,'main',scope,'attempt');
  record.checkpoint(work,{budget:{spentUsd:.23}});
  record.openUncertainty('authentication','reset','Reset returned to login without an outcome.');
  record.openUncertainty('authentication','reset','The same unknown with different words.');
  assert.equal(record.snapshot().investigations?.length,1);
  const first=record.reserveInvestigationCheck('form',null,'page-one','Check reset acceptance.');assert.ok(first.id);
  record.completeInvestigationCheck(first.id!,'Actual page: sign-in form; no reset verdict.');
  assert.equal(record.takeStoppingInvestigation(),false,'a completed safe check does not require a duplicate report/read before stopping');
  assert.throws(()=>record.completeInvestigationCheck(first.id!,'A late invented success.'),/stale investigation/);
  record.finish('paused');record.release();record=new RecoveryRecord(dir,'main',scope,'attempt',undefined,true);
  const again=record.reserveInvestigationCheck('form',null,'page-one','Changed wording.');assert.equal(again.id,undefined);assert.match(again.cached!,/no reset verdict/);
  for(const check of ['control','history','form-two']){
    const ticket=record.reserveInvestigationCheck(check,null,'page-two',check);assert.ok(ticket.id);record.completeInvestigationCheck(ticket.id!,`Actual ${check} evidence is inconclusive.`);
  }
  assert.equal(record.reserveInvestigationCheck('another',null,'page-three','One more').id,undefined);
  assert.deepEqual(record.snapshot().work,work);assert.equal(record.snapshot().controls?.budget&&JSON.stringify(record.snapshot().controls?.budget),'{"spentUsd":0.23}');
  assert.equal(record.snapshot().submissionAttempted,false);assert.equal(record.snapshot().investigations?.[0].status,'investigating');
  record.settleInvestigations('skipped');assert.equal(record.snapshot().investigations?.[0].status,'unresolved');record.release();
});

test('unknown sends remain unknown after a read, specialist advice or a prepared outcome',()=>{
  const record=new RecoveryRecord(directory(),'main',scope,'attempt');
  try {
    const operation=record.begin('browser_action','click',true);record.complete(operation,'Send clicked; response unavailable.','completed',work,true);
    assert.equal(record.snapshot().investigations?.[0].kind,'submission');assert.equal(record.takeStoppingInvestigation(),true);assert.equal(record.takeStoppingInvestigation(),false);
    const check=record.reserveInvestigationCheck('history',null,'state','Was it sent?');record.completeInvestigationCheck(check.id!,'Send intent recorded; no actual receipt.');
    const advice=record.reserveAdvice()!;record.acceptAdvice(advice,'key','The send might have succeeded.');
    assert.equal(record.snapshot().investigations?.[0].status,'investigating');
    record.settleInvestigations('prepared');assert.equal(record.snapshot().investigations?.[0].status,'unresolved');assert.equal(record.snapshot().submissionAttempted,true);
  } finally {record.release();}
});
