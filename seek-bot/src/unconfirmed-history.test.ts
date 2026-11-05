import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withApplicationModel} from './application-model.js';
import {AppliedIndex,recordUnconfirmedApplication} from './store.js';
import type {ApplyOutcome,JobListing} from './types.js';

test('possible sends remain visible and block duplicates without becoming confirmed submissions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'unconfirmed-history-'));
 try{await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false'},async()=>{
  const index=new AppliedIndex();
  const job:JobListing={id:'external-fixture',title:'Dog walker',company:'Fixture Dogs',location:'Sydney',url:'https://employer.fixture.invalid/jobs/',platform:'external',applicationMode:'external'};
  const outcome:ApplyOutcome={status:'skipped',jobId:job.id,reason:'No receipt after native Submit.',submitPressed:true,coverLetter:'Captured letter',resume:'CV.txt',answers:[{question:'Licence',answer:'Yes'}]};
  assert.equal(recordUnconfirmedApplication(index,job,outcome),true);
  const [saved]=JSON.parse(readFileSync(join(dir,'applied.json'),'utf8'));
  assert.equal(saved.confirmationStatus,'unconfirmed');assert.equal(saved.submittedByMyasis,false);
  assert.equal(saved.company,job.company);assert.equal(saved.site,'employer.fixture.invalid');assert.equal(saved.coverLetter,'Captured letter');
  assert.equal(index.appliedToday(),0,'a possible send spends no confirmed submission count');
  assert.equal(new AppliedIndex().hasApplication(job),true,'the persistent record prevents a second automatic send after restart');
  assert.equal(recordUnconfirmedApplication(index,job,outcome),false);assert.equal(index.all.length,1);
  assert.equal(recordUnconfirmedApplication(index,{...job,id:'never-sent'},{...outcome,jobId:'never-sent',submitPressed:false}),false);
  assert.equal(recordUnconfirmedApplication(index,{...job,id:'draft'},{status:'rehearsed',jobId:'draft',stoppedAt:'No send',answers:[],submitPressed:true}),false);
  for(const status of ['error','needs-human'] as const){
   const id='possible-'+status,uncertain:ApplyOutcome=status==='error'?{status,jobId:id,error:'Browser closed',submitPressed:true}:{status,jobId:id,url:job.url,reason:'Candidate fact missing after a possible send',submitPressed:true};
   assert.equal(recordUnconfirmedApplication(index,{...job,id,url:job.url+id},uncertain),true);
  }
  const confirmed={...saved,jobId:'confirmed',url:job.url+'confirmed',confirmationStatus:undefined,submittedByMyasis:true};index.add(confirmed);
  assert.equal(recordUnconfirmedApplication(index,{...job,id:'confirmed',url:confirmed.url},outcome),false,'a late uncertain result cannot overwrite confirmed history');
  assert.equal(index.all.find(row=>row.jobId==='confirmed')?.confirmationStatus,undefined);
  assert.equal(index.appliedToday(),1);
 });}finally{rmSync(dir,{recursive:true,force:true});}
});
