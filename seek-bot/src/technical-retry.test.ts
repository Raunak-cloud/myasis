import assert from 'node:assert/strict';
import { test } from 'node:test';
import { technicalFailure,retryShortfall } from './technical-retry-types.js';
import { withApprovedRetry,approvedApplication,approvedApplications,reviewingApplications,preparingApplications } from './application-review.js';
import type { PreparedApplication } from './application-review-types.js';

test('fallback uses only the shortfall in online matches within the current run/day allowance',()=>{
 assert.equal(retryShortfall(4,20,20),16);
 assert.equal(retryShortfall(20,20,20),0);
 assert.equal(retryShortfall(30,20,20),0);
 assert.equal(retryShortfall(4,Infinity,7),3);
 assert.equal(retryShortfall(4,100,0),0);
});
test('technical failures stay distinct from matching decisions, personal questions and possible sends',()=>{
 for(const value of [{status:'error',error:'Browser disconnected'},{status:'skipped',reason:'Application budget exhausted'},
  {status:'needs-human',reason:'CAPTCHA verification failed'},{status:'error',error:'A provider failed',retryable:false}])assert.equal(technicalFailure(value),true);
 for(const value of [{status:'applied'},{status:'already-applied'},{status:'skipped',reason:'Not the requested role'},
  {status:'skipped',reason:'Technical failure',fitRejection:{source:'listing'}},
  {status:'error',submitPressed:true,error:'Browser disconnected'},
  {status:'needs-human',reason:'Verification failed',questions:[{question:'What is your date of birth?'}]},
  {status:'error',error:'Account access failed',accountAccess:{}}])assert.equal(technicalFailure(value),false);
});
test('concurrent approved retries retain exact owner-approved content without changing other Auto applications',async()=>{
 const old=process.env.APPLICATION_REVIEW_MODE;process.env.APPLICATION_REVIEW_MODE='';
 const draft=(id:string):PreparedApplication=>({id,revision:'approved-'+id,preparedAt:'2026-11-09T00:00:00Z',
  job:{id,platform:'seek',title:'Analyst',company:'Fixture',location:'Sydney',url:'https://example.test/job/'+id},
  formUrl:'https://example.test/job/'+id,coverLetter:'Exact letter '+id,resume:'Exact resume '+id,answers:[{question:'Notice',answer:'Immediate'}]});
 try{
  await Promise.all(['one','two'].map(id=>withApprovedRetry(draft(id),async()=>{
    await new Promise(done=>setTimeout(done,5));
    assert.equal(reviewingApplications(),true);assert.equal(preparingApplications(),false);
    assert.equal(approvedApplication(draft(id).job)?.coverLetter,'Exact letter '+id);
    assert.equal(approvedApplication(draft(id==='one'?'two':'one').job),undefined);
    assert.equal(approvedApplications().length,1);
  })));
  assert.equal(reviewingApplications(),false);assert.deepEqual(approvedApplications(),[]);
 }finally{if(old===undefined)delete process.env.APPLICATION_REVIEW_MODE;else process.env.APPLICATION_REVIEW_MODE=old;}
});
