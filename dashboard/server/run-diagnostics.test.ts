import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRunDiagnostics,readRunAttempt} from './run-diagnostics.js';

test('operator report preserves recovered errors, deduplicates console events and rejects foreign attempts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'run-diagnostic-api-')),other=mkdtempSync(join(tmpdir(),'run-diagnostic-other-'));
 const id='11111111-1111-4111-8111-111111111111';mkdirSync(join(dir,'traces'));
 const start={id:'start',runStartId:'12',attemptId:id,jobId:'job',title:'Test',company:'Test',mode:'prepare',startedAt:'2026-10-30T00:00:00Z',at:'2026-10-30T00:00:00Z',severity:'info',category:'attempt_started',message:'Attempt started'};
 const issue={...start,id:'issue',severity:'warning',category:'tool_error',stage:'tool',step:2,tool:'browser_batch',batchIndex:1,message:'Ambiguous control'};
 const end={...start,id:'end',category:'attempt_finished',outcome:'prepared'};
 writeFileSync(join(dir,'traces','run-12.diagnostics.jsonl'),[start,issue,end].map(e=>JSON.stringify(e)).join('\n')+'\n{"partial":');
 writeFileSync(join(dir,'traces',`attempt-${id}.json`),JSON.stringify({attemptId:id,runStartId:'12',steps:[{step:2,result:'failed'}]}));
 try {
  const r=readRunDiagnostics('12',dir,[{stream:'out',ts:issue.at,text:'[run-diagnostic] '+JSON.stringify(issue)},
   {stream:'err',ts:issue.at,text:'Warning: PDF font warning'}]);
  assert.equal(r.issues.length,2);assert.equal(r.attempts[0].outcome,'prepared');assert.equal(r.issues[0].step,2);
  assert.ok(readRunAttempt('12',dir,id));assert.equal(readRunAttempt('13',dir,id),null);
  assert.equal(readRunAttempt('12',other,id),null);assert.equal(readRunAttempt('12',dir,'../../etc/passwd'),null);
  assert.equal(readRunDiagnostics('12',other,[]).structured,false);
  assert.throws(()=>readRunDiagnostics('../12',dir,[]));
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
