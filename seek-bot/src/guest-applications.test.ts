import assert from 'node:assert/strict';
import {test} from 'node:test';
import {guestEmployerAccountRequired,GUEST_EMPLOYER_SOURCES} from './guest-applications.js';
import {buildApplicationSystemPrompt} from './agent/application-policy.js';
import {withApplicationModel} from './application-model.js';
import {doCompleteAuthentication} from './agent/authentication.js';
import {applyToJoraJob} from './jora-browser.js';

test('free guest policy distinguishes employer pages from connected native boards and leaves paid prompts unchanged',()=>{
 assert.deepEqual([...GUEST_EMPLOYER_SOURCES],['smartrecruiters','greenhouse']);
 for(const url of ['https://jobs.smartrecruiters.com/Fixture/1','https://fixture.wd1.myworkdayjobs.com/en-US/jobs'])assert.equal(guestEmployerAccountRequired(url,true),true);
 for(const url of ['https://www.seek.com.au/job/123','https://secure.indeed.com/login'])assert.equal(guestEmployerAccountRequired(url,true),false);
 assert.equal(guestEmployerAccountRequired('https://employer.org/signup',false),false);
 assert.doesNotMatch(buildApplicationSystemPrompt(''),/FREE EMPLOYER APPLICATIONS/);assert.match(buildApplicationSystemPrompt('',true),/Never create or recover an employer account/);assert.match(buildApplicationSystemPrompt('',true),/Ordinary verification of an application email is allowed/);
});

test('free Jora discovery cannot start a SEEK or Indeed application through an aggregator',async()=>{
 for(const url of ['https://www.seek.com.au/job/123','https://au.indeed.com/viewjob?jk=1234567890abcdef']){
  const result=await withApplicationModel({FREE_EMPLOYER_GUEST_ONLY:'true'},()=>applyToJoraJob({} as any,{id:'jora-fixture',url} as any,{} as any,{} as any));
  assert.equal(result.status,'skipped');assert.match('reason' in result?result.reason||'':'',/direct employer applications only/);
 }
});

test('free employer authentication cannot fill or generate credentials; an incorrect tool choice can recover to a guest form',async()=>{
 const ctx={page:{url:()=> 'https://employer.example/signup'}} as any;
 for(const purpose of ['create_account','reset_password','sign_in']){
  const result=await withApplicationModel({FREE_EMPLOYER_GUEST_ONLY:'true'},()=>doCompleteAuthentication(ctx,{purpose,refs:['password']}));
  assert.equal(result.kind,'ok');if(result.kind==='ok'){assert.equal(result.disposition,'reobserve');assert.match(result.message,/No account was created/);assert.match(result.message,/guest application/);}
 }
 // No credential source, DOM methods or profile were supplied: reaching them
 // would fail this fixture. The policy returns before any account operation.
});
