import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withApplicationModel } from './application-model.js';
import type { CandidateProfile,JobListing } from './types.js';
const dir=mkdtempSync(join(tmpdir(),'owtomate-job-letter-'));
process.env.DATA_DIR=dir;process.env.COST_TRACKING='false';process.env.RESUME_SELECT='cv';
mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes','CV.txt'),'Fixture resume');
writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt',isDefault:true}]));
const {prepareMatchedJob}=await import('./prepare-job.js');
const {applicationRevision,withCoverLetter}=await import('./application-review-content.js');
const job={id:'fixture',title:'Analyst',company:'Fixture',location:'Sydney',platform:'seek',url:'https://www.seek.com.au/job/12345678'} as JobListing;
const profile={name:'Fixture Candidate',email:'owner@fixture.invalid'} as CandidateProfile;

test('preparation saves only matched job, checked access, selected resume and grounded letter; no form or send executor is used',async()=>{
 try{await withApplicationModel({DATA_DIR:dir,RESUME_SELECT:'cv'},async()=>{
  let letters=0;
  const result=await prepareMatchedJob({} as never,job,profile,{access:async()=>({ok:true,access:'no-login-required',checkedUrl:job.url}),letter:async()=>{letters++;return 'Dear Hiring Manager,\n\nMy supported experience suits this role.\n\nFixture Candidate';}});
  assert.equal(result.status,'prepared');assert.equal(letters,1);
  if(result.status!=='prepared')return;
  const d=result.draft;
  assert.deepEqual(d.answers,[]);assert.equal(d.preparation?.stage,'job-and-letter');assert.equal(d.resumeId,'cv');assert.equal(d.resume,'CV.txt');assert.match(d.resumeHash!,/^[a-f0-9]{64}$/);
  assert.equal(d.formUrl,job.url);assert.equal(d.revision,applicationRevision(d));
  const p=d.preparation!;
  // JSONB preserves values, but not the worker's object key insertion order.
  const databaseDraft={...d,preparation:{stage:p.stage,access:p.access,version:p.version,checkedAt:p.checkedAt,checkedUrl:p.checkedUrl}};
  assert.equal(applicationRevision(databaseDraft),d.revision,'database key reordering must preserve candidate consent');
  const reverseDraft={...d,preparation:Object.fromEntries(Object.entries(p).reverse()) as typeof p};
  assert.equal(applicationRevision(reverseDraft),d.revision,'metadata order is not a content change');
  assert.notEqual(applicationRevision({...databaseDraft,preparation:{...databaseDraft.preparation,access:'signed-in'}}),d.revision);
  assert.notEqual(applicationRevision({...databaseDraft,preparation:{...databaseDraft.preparation,checkedUrl:'https://other.fixture.invalid/application'}}),d.revision);
  assert.notEqual(applicationRevision({...d,preparation:undefined}),d.revision,'letter-only approval cannot be confused with a completed-form draft');
  const edited=withCoverLetter(d,'A corrected truthful letter.');assert.equal(edited.preparation?.stage,'job-and-letter');assert.notEqual(edited.revision,d.revision);
  const skipped=await prepareMatchedJob({} as never,job,profile,{access:async()=>({ok:false,reason:'Login unavailable'}),letter:async()=>{throw Error('Must not draft a skipped job');}});
  assert.equal(skipped.status,'skipped');assert.equal(letters,1);
 });}finally{rmSync(dir,{recursive:true,force:true});}
});
