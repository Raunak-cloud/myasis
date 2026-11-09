import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { withApplicationModel } from './application-model.js';
import { completedReview, reuseCompletedReview, COMPLETED_REVIEWS_FILE } from './completed-reviews.js';
import type { FitAssessment } from './llm.js';
import type { JobListing } from './types.js';

const job: JobListing={id:'123',platform:'seek',title:'Analyst',company:'Fixture',location:'Sydney',url:'https://www.seek.com.au/job/123'};
const fit=(decision:FitAssessment['decision']):FitAssessment=>({decision,shouldApply:decision==='apply',matchScore:decision==='apply'?85:30,
  reason:'Saved completed review',evidence:['Fixture evidence'],injectionSuspected:false});

test('completed decisions persist across runs, models, profile/advert changes and restarts, with owner/source isolation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'owtomate-completed-review-'));
  const env={...process.env,DATA_DIR:directory,APPLICATION_AI_MODEL:'celeris'};
  let calls=0;
  try{
    await withApplicationModel(env,async()=>{
      for(const decision of ['apply','skip','uncertain'] as const){
        const listing={...job,id:decision,url:`https://www.seek.com.au/job/${decision}`};
        const first=await reuseCompletedReview(listing,async()=>{calls++;return fit(decision);});
        const again=await reuseCompletedReview({...listing,title:'Edited title',description:'Changed ad',salary:'$180,000'},async()=>{throw Error('Do not review a completed job again');});
        assert.equal(again.decision,first.decision);assert.equal(again.reviewReused,true);
      }
      assert.equal(calls,3);
      await withApplicationModel({...env,APPLICATION_AI_MODEL:'minimax'},async()=>{
        await reuseCompletedReview({...job,id:'apply',url:'https://www.seek.com.au/job/apply'},async()=>{throw Error('Model selection cannot erase completed reviews');});
      });
      // A failed response does not become a permanent rejected job.
      await assert.rejects(reuseCompletedReview(job,async()=>{throw Error('Temporary outage');}),/Temporary outage/);
      assert.equal(completedReview(job),undefined);
      await Promise.all(Array.from({length:25},()=>reuseCompletedReview(job,async()=>{calls++;await new Promise(done=>setTimeout(done,5));return fit('apply');})));
      assert.equal(calls,4,'concurrent work for one owner is reviewed only once');
      assert.equal((await reuseCompletedReview({...job,platform:'indeed',url:'https://au.indeed.com/viewjob?jk=123'},async()=>{calls++;return fit('skip');})).decision,'skip');
      assert.equal(calls,5,'equal IDs on different sources must not share decisions');
      // Explicitly identified employer vacancy mirrors reuse their existing review.
      const external={...job,id:'employer',applicationUrl:'https://employer.example/jobs/abc?utm_source=seek'};
      await reuseCompletedReview(external,async()=>{calls++;return fit('apply');});
      await reuseCompletedReview({...external,platform:'indeed',id:'mirror',applicationUrl:'https://employer.example/jobs/abc?utm_source=indeed'},async()=>{throw Error('Same employer vacancy must reuse its decision');});
      await reuseCompletedReview({...external,id:'different',applicationUrl:'https://employer.example/jobs/def'},async()=>{calls++;return fit('apply');});
      assert.equal(calls,7,'a distinct requisition is reviewed independently');
      appendFileSync(join(directory,COMPLETED_REVIEWS_FILE),'{partial crash record');
      await reuseCompletedReview({...job,id:'after-crash',url:'https://www.seek.com.au/job/after-crash'},async()=>fit('skip'));
    });
    await withApplicationModel({...env,DATA_DIR:join(directory,'peer')},async()=>{
      assert.equal(completedReview(job),undefined);
      assert.equal((await reuseCompletedReview(job,async()=>fit('skip'))).decision,'skip');
    });
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      globalThis.fetch=async()=>{throw Error('No network allowed');};
      const {reuseCompletedReview}=await import(${JSON.stringify(new URL('./completed-reviews.js',import.meta.url).href)});
      for(const id of ['apply','skip','uncertain','after-crash']){
        const result=await reuseCompletedReview({...${JSON.stringify(job)},id,url:'https://www.seek.com.au/job/'+id},async()=>{throw Error('Completed review lost after process restart');});
        if(!result.reviewReused)process.exit(1);
      }
    `],{env:{...env,APPLICATION_AI_MODEL:'minimax'},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    assert.equal(readFileSync(join(directory,COMPLETED_REVIEWS_FILE),'utf8').split('\n').filter(s=>s.startsWith('{"key"')).length,8);
  }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-completed-review-'));rmSync(directory,{recursive:true,force:true});}
});

test('unresolved company checks remain retryable while confirmed exclusions are remembered',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'owtomate-completed-review-'));
 try{await withApplicationModel({...process.env,DATA_DIR:directory},async()=>{
   await reuseCompletedReview(job,async()=>({...fit('uncertain'),companyExclusionCheck:{decision:'uncertain'} as never}));
   assert.equal(completedReview(job),undefined);
   const result=await reuseCompletedReview(job,async()=>fit('apply'));
   assert.equal(result.shouldApply,true);assert.equal(result.reviewReused,undefined);
   const excluded={...job,id:'excluded',url:'https://www.seek.com.au/job/excluded'};
   await reuseCompletedReview(excluded,async()=>({...fit('skip'),companyExclusionCheck:{decision:'excluded'} as never}));
   assert.equal(completedReview(excluded)?.assessment.decision,'skip');
 });}finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-completed-review-'));rmSync(directory,{recursive:true,force:true});}
});

test('concurrent cross-board mirrors share one review when they expose the same vacancy destination',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'owtomate-completed-review-'));let calls=0;
 try{await withApplicationModel({...process.env,DATA_DIR:directory},async()=>{
   const compute=async()=>{calls++;await new Promise(done=>setTimeout(done,10));return fit('apply');};
   const applicationUrl='https://employer.example/jobs/shared-requisition';
   const results=await Promise.all([reuseCompletedReview({...job,applicationUrl},compute),reuseCompletedReview({...job,platform:'indeed',id:'mirror',applicationUrl},compute)]);
   assert.equal(calls,1);assert.ok(results.every(x=>x.shouldApply));
 });}finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-completed-review-'));rmSync(directory,{recursive:true,force:true});}
});
