import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftCoverLetter } from './llm.js';
import { withApplicationModel } from './application-model.js';
import type { CandidateProfile, JobListing } from './types.js';

const job={id:'letter-fixture',title:'Analyst',company:'Fixture Employer',location:'Sydney',url:'https://employer.fixture.invalid/job'} as JobListing;
const profile:CandidateProfile={name:'Fixture Candidate',email:'candidate@fixture.invalid',nationality:'',phone:'',expectedSalary:'',noticePeriod:'',willingToRelocate:false,experienceSummary:'Fixture experience',skills:[],excludedDomains:[],securityClearance:''};
const letter=(words:number)=>Array.from({length:words},()=> 'example').join(' ');
const supported={supported:true,reason:'Fixture claims supported'};

async function fixture(replies:unknown[],work:(prompts:string[])=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'cover-letter-length-')),original=globalThis.fetch,prompts:string[]=[];
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));prompts.push(body.messages.map((m:{content:string})=>m.content).join('\n'));
  assert.ok(replies.length,'Unexpected extra model request');
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(replies.shift())}}],usage:{prompt_tokens:1,completion_tokens:1,cost:0}});
 };
 try{await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false',APPLICATION_AI_MODEL:'minimax',OPENROUTER_API_KEY:'fixture-only'},()=>work(prompts));assert.equal(replies.length,0);}
 finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
}

test('125 through 375 words reach evidence validation unchanged, without a shortening call',async()=>{
 for(const words of [125,250,251,300,375]){
  const draft=letter(words);
  await fixture([{letter:draft},supported],async prompts=>{
   assert.equal(await draftCoverLetter(job,profile,''),draft);
   assert.equal(prompts.length,2);assert.match(prompts[0],/Aim for 250 words/);assert.match(prompts[0],/125-375/);
   assert.match(prompts[1],/Check factual claims/);
  });
 }
});

test('376 words trigger shortening, and a shortened 375-word letter remains valid',async()=>{
 await fixture([{letter:letter(376)},{letter:letter(375)},supported],async prompts=>{
  assert.equal(await draftCoverLetter(job,profile,''),letter(375));
  assert.match(prompts[1],/Shorten the cover letter/);assert.match(prompts[1],/at most 375 words/);
 });
});

test('a letter still over 375 after shortening is rejected with the current limit',async()=>{
 await fixture([{letter:letter(376)},{letter:letter(376)}],async()=>{
  await assert.rejects(draftCoverLetter(job,profile,''),/within 375 words/);
 });
});

test('factual repairs can exceed 250 words while remaining within tolerance and evidence checked',async()=>{
 await fixture([{letter:letter(300)},{supported:false,reason:'Remove an unsupported claim'},{letter:letter(360)},supported],async prompts=>{
  assert.equal(await draftCoverLetter(job,profile,''),letter(360));
  assert.match(prompts[2],/125-375/);assert.match(prompts[3],/Check factual claims/);
 });
});

test('word-count tolerance does not bypass unsupported factual claims',async()=>{
 const unsupported={supported:false,reason:'Unsupported qualification'};
 await fixture([{letter:letter(300)},unsupported,{letter:letter(300)},unsupported,{letter:letter(300)},unsupported],async()=>{
  await assert.rejects(draftCoverLetter(job,profile,''),/unsupported factual claims after repair/);
 });
});
