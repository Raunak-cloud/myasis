import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withApplicationModel } from './application-model.js';
import { withApplicationAllowance } from './application-allowance.js';
import type { CandidateProfile,JobListing } from './types.js';
const dir=mkdtempSync(join(tmpdir(),'owtomate-job-letter-'));
process.env.DATA_DIR=dir;process.env.COST_TRACKING='false';process.env.RESUME_SELECT='cv';
mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes','CV.txt'),'Fixture resume');
writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt',isDefault:true}]));
const {prepareMatchedJob}=await import('./prepare-job.js');
const {applicationRevision,withCoverLetter}=await import('./application-review-content.js');
const job:JobListing={id:'fixture',title:'Analyst',company:'Fixture',location:'Sydney',platform:'seek',url:'https://www.seek.com.au/job/12345678',description:'A current analyst vacancy requiring evidence-based reporting.'};
const profile={name:'Fixture Candidate',email:'owner@fixture.invalid'} as CandidateProfile;

test('listing-only preparation drafts for a login-gated destination without browser access or a submit-allowance call',async()=>{
 try{await withApplicationModel({DATA_DIR:dir,RESUME_SELECT:'cv'},async()=>{
  let letters=0;
  const matched={...job,applicationMode:'external' as const,applicationUrl:'https://employer.fixture.invalid/login'};
  const result=await withApplicationAllowance(()=>{throw Error('Preparation must not check submission access');},()=>prepareMatchedJob(matched,profile,{letter:async observed=>{letters++;assert.equal(observed.description,job.description);return 'Dear Hiring Manager,\n\nMy supported experience suits this role.\n\nFixture Candidate';}}));
  assert.equal(result.status,'prepared');assert.equal(letters,1);
  if(result.status!=='prepared')return;
  const d=result.draft,p=d.preparation!;
  assert.equal(p.version,2);if(p.version!==2)return;
  assert.equal(p.access,'not-checked');assert.equal(p.listingUrl,job.url);assert.equal('checkedUrl' in p,false);
  assert.deepEqual(d.answers,[]);assert.equal(d.resumeId,'cv');assert.equal(d.resume,'CV.txt');assert.match(d.resumeHash!,/^[a-f0-9]{64}$/);
  assert.equal(d.formUrl,matched.applicationUrl);assert.equal(d.revision,applicationRevision(d));
  const reversed={...d,preparation:Object.fromEntries(Object.entries(p).reverse()) as typeof p};
  assert.equal(applicationRevision(reversed),d.revision,'JSONB key ordering must preserve consent');
  assert.notEqual(applicationRevision({...d,preparation:{...p,listingUrl:'https://other.fixture.invalid/job'}}),d.revision);
  const legacy={...d,preparation:{version:1 as const,stage:'job-and-letter' as const,access:'no-login-required' as const,checkedAt:'2026-01-01T00:00:00.000Z',checkedUrl:matched.applicationUrl}};
  const legacyReordered={...legacy,preparation:{checkedUrl:legacy.preparation.checkedUrl,checkedAt:legacy.preparation.checkedAt,access:legacy.preparation.access,stage:legacy.preparation.stage,version:legacy.preparation.version}};
  assert.equal(applicationRevision(legacyReordered),applicationRevision(legacy));assert.notEqual(applicationRevision(legacy),d.revision);
  assert.notEqual(applicationRevision({...d,preparation:undefined}),d.revision);
  const edited=withCoverLetter(d,'A corrected truthful letter.');assert.equal(edited.preparation?.version,2);assert.notEqual(edited.revision,d.revision);
  const trace=JSON.parse(readFileSync(join(dir,'traces','fixture.json'),'utf8'));
  assert.equal(trace.sendAudit.attempted,false);assert.deepEqual(trace.steps.map((s:{tool:string})=>s.tool),['prepare_job_and_letter']);
  const missing=await prepareMatchedJob({...job,description:''},profile,{letter:async()=>{throw Error('Do not invent a description');}});
  assert.equal(missing.status,'error');assert.equal(letters,1);
  await withApplicationModel({DATA_DIR:dir,RESUME_SELECT:'cv',FREE_EMPLOYER_GUEST_ONLY:'true'},async()=>{
    const page={} as import('patchright').Page;
    const proof={version:3 as const,stage:'job-and-letter' as const,access:'guest-confirmed' as const,checkedAt:new Date().toISOString(),checkedUrl:'https://fixture.invalid/apply',evidence:'Apply for this job',isolation:'no-employer-session' as const,method:'form' as const};
    for(const status of ['skipped','error'] as const){
      const blocked=await prepareMatchedJob(matched,profile,{page,access:async()=>({ok:false,status,reason:status==='skipped'?'An employer account is required.':'Guest access could not be confirmed.'}),letter:async()=>{throw Error('Unverified destinations must not generate a cover letter or spend a preparation credit');}});
      assert.equal(blocked.status,status);
    }
    assert.equal((await prepareMatchedJob(matched,profile,{letter:async()=>{throw Error('No browser');}})).status,'error');
    const nativeViaJora=await prepareMatchedJob({...matched,platform:'jora'},profile,{page,access:async()=>({ok:true,proof:{...proof,access:'hosted-confirmed',checkedUrl:'https://www.seek.com.au/job/12345678/apply'}}),letter:async()=>{throw Error('An unsupported aggregate handoff must not spend a Free credit');}});
    assert.equal(nativeViaJora.status,'skipped');
    const ready=await prepareMatchedJob(matched,profile,{page,access:async()=>({ok:true,proof}),letter:async()=> 'A truthful, tailored letter.'});
    assert.equal(ready.status,'prepared');
    if(ready.status==='prepared'){
      assert.deepEqual(ready.draft.preparation,proof);
      assert.equal(applicationRevision({...ready.draft,preparation:Object.fromEntries(Object.entries(proof).reverse()) as typeof proof}),ready.draft.revision,'new proof survives JSONB key ordering');
      assert.notEqual(applicationRevision({...ready.draft,preparation:{...proof,evidence:'Changed evidence'}}),ready.draft.revision);
      assert.equal(withCoverLetter(ready.draft,'A corrected letter.').preparation?.version,3,'letter edits retain access proof');
    }
  });
 });}finally{rmSync(dir,{recursive:true,force:true});}
});
