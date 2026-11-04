import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import type {ToolContext} from './context.js';
import {CostMeter} from './celeris.js';
import {withApplicationModel} from '../application-model.js';
import {reviewApplicationRecovery,recoveryEvidenceText} from './recovery-review.js';
import {newConsultationState} from './consultation.js';
import {renderObservation} from './observe.js';

const directory=mkdtempSync(join(tmpdir(),'unified-review-'));
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','cv.txt'),'Fictional candidate. Actual notice period: 2 weeks.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',fileName:'cv.txt',isDefault:true}]));
const env={...process.env,DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',COST_TRACKING:'false'};
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
const originalFetch=globalThis.fetch;
after(async()=>{globalThis.fetch=originalFetch;await browser.close();rmSync(directory,{recursive:true,force:true});});
const answer=()=>Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{content:JSON.stringify({
 advice:'Inspect the actual supporting documents; the blank notice field has a saved candidate answer.',
 evidence:[{source:'profile',detail:'noticePeriod: 2 weeks'}],unknowns:[],nextSteps:['Inspect the cover letter and fill the known notice period.'],
 recovery_goal:{kind:'field-value',target:'Notice period',value:'2 weeks'},
})}}]});
async function fixture(){
 const context=await browser.newContext(),page=await context.newPage();let navigations=0,sends=0;
 await context.route('**/*',route=>{navigations++;if(route.request().method()==='POST')sends++;return route.fulfill({contentType:'text/html',body:
  '<main><h1>Review application</h1><label>Notice period<input id=notice></label><label>Resume<input id=cv type=file></label><label>Password<input type=password value="private-fixture-password"></label><p>'+('Fictional resume content. '.repeat(950))+'</p><section><h2>Supporting documents</h2><p>Cover letter: EXACT TAILORED LETTER PRESENT</p></section><button id=send onclick="window.sent=true">Submit application</button></main>'});});
 await page.goto('https://review.fixture.invalid/apply');await page.locator('#notice').fill('Unsaved candidate entry');
 await page.locator('#cv').setInputFiles({name:'CV.txt',mimeType:'text/plain',buffer:Buffer.from('Fictional bytes')});
 const ctx={page,profile:{name:'Fixture Candidate',noticePeriod:'2 weeks',skills:[]},job:{id:'fixture',title:'Analyst',company:'Fixture',url:page.url()},
  observation:{url:page.url(),title:'Application',text:'',fields:[],actions:[]},captured:[],actions:[],resumeUsed:'cv',log:()=>{}} as unknown as ToolContext;
 return {context,page,ctx,counts:()=>({navigations,sends}),options:{enabled:true,meter:new CostMeter(1),state:newConsultationState()}};
}

test('reviewer and parent share cover-letter evidence below a long resume; reinspection never reloads or loses unsaved inputs',async()=>{
 const f=await fixture();let seen='';
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));seen=body.messages[1].content;
  assert.match(body.messages[0].content,/SINGLE RECOVERY REVIEWER/);assert.match(body.messages[0].content,/BEFORE submitting/);
  assert.deepEqual(body.tools.map((t:any)=>t.function.name),['return_application_advice']);
  assert.match(seen,/EXACT TAILORED LETTER PRESENT/);assert.match(seen,/2 weeks/);assert.doesNotMatch(seen,/private-fixture-password/);return answer();};
 try{await withApplicationModel(env,async()=>{
  const result=await reviewApplicationRecovery(f.ctx,{question:'The cover letter or notice period seems missing.'},{...f.options,proposedStop:{status:'error',reason:'Cover letter missing'}});
  assert.equal(result.kind,'ok');assert.match(result.kind==='ok'?result.message:'',/READ-ONLY SPECIALIST ADVICE/);
  assert.ok(f.ctx.observation.reviewEvidence?.id);assert.ok(seen.includes(f.ctx.observation.reviewEvidence!.id));
  assert.match(renderObservation(f.ctx.observation),/EXACT TAILORED LETTER PRESENT/);
  assert.equal(await f.page.locator('#notice').inputValue(),'Unsaved candidate entry');
  assert.equal(await f.page.locator('#cv').evaluate((e:HTMLInputElement)=>e.files?.[0]?.name),'CV.txt');
  assert.deepEqual(f.counts(),{navigations:1,sends:0});assert.equal(await f.page.evaluate(()=>Boolean((window as any).sent)),false);
 });}finally{await f.context.close();}
});

test('asynchronous same-URL changes retire advice; no stale recovery evidence is published',async()=>{
 const f=await fixture();globalThis.fetch=async()=>{await f.page.locator('#notice').fill('Asynchronous employer change');return answer();};
 try{await withApplicationModel(env,async()=>{
  const r=await reviewApplicationRecovery(f.ctx,{question:'Inspect the current validation.'},f.options);
  assert.match(r.kind==='ok'?r.message:'',/STALE SPECIALIST ADVICE DISCARDED/);
  assert.equal(f.ctx.observation.reviewEvidence,undefined);assert.equal(f.counts().navigations,1);
 });}finally{await f.context.close();}
});

test('overlapping review requests share one owner and cannot launch a second reviewer',async()=>{
 const f=await fixture();let requests=0,release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
 globalThis.fetch=async()=>{requests++;started();await gate;return answer();};
 try{await withApplicationModel(env,async()=>{
  const first=reviewApplicationRecovery(f.ctx,{question:'Inspect the current form.'},f.options);await ready;
  const second=await reviewApplicationRecovery(f.ctx,{question:'Inspect it again concurrently.'},f.options);
  assert.match(second.kind==='ok'?second.message:'',/already in progress/);release();await first;
  assert.equal(requests,1);assert.equal(f.options.state.calls,1);assert.equal(f.counts().navigations,1);
 });}finally{release?.();await f.context.close();}
});

test('possible sends prohibit automatic recovery; manual outcome inspection has no helper or browser execution capability',async()=>{
 const f=await fixture();f.ctx.submissionAttempted=true;let requests=0;
 globalThis.fetch=async(_url,init)=>{requests++;assert.deepEqual(JSON.parse(String(init?.body)).tools.map((t:any)=>t.function.name),['return_application_advice']);return answer();};
 try{await withApplicationModel(env,async()=>{
  const r=await reviewApplicationRecovery(f.ctx,{question:'Try recovery after sending.'},{...f.options,trigger:'automatic'});
  assert.match(r.kind==='ok'?r.message:'',/send may already/);assert.equal(requests,0);
  await reviewApplicationRecovery(f.ctx,{question:'Interpret the current employer response read-only.'},f.options);
  assert.equal(requests,1);assert.equal(f.counts().sends,0);
 });}finally{await f.context.close();}
});

test('oversized review evidence retains middle document sections as well as beginning and end',()=>{
 const text='PAGE START'+('Required field '+'.'.repeat(2000)).repeat(35)+'Supporting documents Cover letter: middle proof'+'.'.repeat(70_000)+'PAGE END';
 const bounded=recoveryEvidenceText(text);assert.ok(bounded.length<=50_000);assert.match(bounded,/PAGE START/);assert.match(bounded,/middle proof/);assert.match(bounded,/PAGE END/);
});
