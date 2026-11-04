/** Sony's recorded failure sequence, reproduced locally with fictional data.
 * Real applying loop, native DOM, actual preparation/readiness and checkpoint
 * persistence; scripted model and invalid-domain routes, no external sends. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {DatabaseSync} from 'node:sqlite';
import {createReadinessFixtureReply} from './readiness-fixture.js';
import {isSpecialistFixtureRequest,fixtureToolArguments} from './specialist-fixture.js';
const directory=mkdtempSync(join(tmpdir(),'sony-recovery-regression-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',APPLICATION_REVIEW_MODE:'prepare',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',COST_TRACKING:'false',DRY_RUN:'true',ALLOW_EXTERNAL_APPLY:'true',OWTOMATE_LIVE_REPAIR:'',AGENT_BUDGET_USD:'1.00',AGENT_PROGRESS_BUDGET_USD:'1.00',CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0'});
const{runAgentOnlyApplication}=await import('./agent-only.js');
const{outcomeFromRun}=await import('./outcome.js');
const{logOutcome}=await import('../store.js');
const{closeCelerisQueues}=await import('../../../shared/celeris-queue.mjs');
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Fictional candidate resume for a synthetic recovery regression.');writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'CV',fileName:'CV.txt'}]));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})}),originalFetch=globalThis.fetch;
try{
 await test('Sony: visual checkbox progress, two rejected quotes, delayed review, actual prepared draft and zero sends',async()=>{
  const context=await browser.newContext(),page=await context.newPage();
  let sends=0;await context.route('**/*',route=>{if(route.request().method()==='POST')sends++;return new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:`<main><h1>Verification step</h1><label>City<input id=city value=Sydney></label><button id=verify type=button onclick="this.setAttribute('aria-checked','true')">Verify you are human</button><section id=review hidden><h2>Review the contents of this job application</h2><p>Analyst, ANZ Data &amp; Insights · Sony Music Global Job Board · Sydney</p><p>Resume: CV.txt</p><button id=send onclick="localStorage.setItem('sends','yes')">Submit your application</button></section></main>`}):route.abort();});
  await page.goto('https://sony-replay.fixture.invalid/application');let parents=0,specialists=0,reviewed=false;const readiness=createReadinessFixtureReply();
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));
   if(isSpecialistFixtureRequest(body)){specialists++;return Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{content:null,tool_calls:[{id:'advice',type:'function',function:{name:'return_application_advice',arguments:fixtureToolArguments(body,'return_application_advice',{advice:'Inspect the visible verification control, then continue to the delayed review form. The applying agent decides the continuation.',evidence:[],unknowns:[],nextSteps:['Click the observed verification control and inspect until the application review is available.'],recovery_goal:{kind:'visible-text',target:'Submit your application',value:'Submit your application'}})}}]}}]});}
   if(body.tool_choice?.function?.name==='record_application_review')reviewed=true;
   const ready=readiness(body);if(ready)return ready;
   assert.ok(++parents<=10,'No reporting loop');assert.ok(!['respond_to_specialist','check_specialist_recovery','finish'].includes(body.tool_choice?.function?.name),'the specialist cannot force the next tool');
   const all=body.messages.map((m:any)=>typeof m.content==='string'?m.content:'').join('\n');const matches=[...all.matchAll(/SPECIALIST RECOVERY OBLIGATION\n([^\n]+)/g)];const task=matches.length?JSON.parse(matches.at(-1)![1]):undefined;
   const calls:Array<{name:string;args:Record<string,unknown>}>=[];
   if(parents===1)calls.push({name:'consult_application_specialist',args:{question:'Inspect the visible verification blocker and suggest a normal interaction.',focus:'form'}});
   if(parents===2)calls.push({name:'respond_to_specialist',args:{advice_id:task.advice_id,decision:'adopt',reason:'Use the observed control then inspect the review.',observation_id:task.observation_id,operation_tool:'browser_action',operation_action:'click',operation_purpose:'Click the verification control and retain the application until review renders.',verification:task.verification}});
   if(parents===3)calls.push({name:'browser_action',args:{action:'click',selector:'#verify',sends_application:false}});
   if(parents===4)calls.push({name:'check_specialist_recovery',args:{advice_id:task.advice_id,assessment:'progress',observation_id:task.observation_id,result_id:task.result_id,reason:'The visual checkbox changed; wait for delayed review rather than calling the job skipped.'}});
   if(parents===5||parents===6){
    if(parents===6)await page.evaluate(()=>{document.getElementById('verify')!.hidden=true;document.getElementById('review')!.hidden=false;});
    calls.push({name:'check_specialist_recovery',args:{advice_id:task.advice_id,assessment:'progress',result_id:task.result_id,observation_quote:'TITLE: Review ... PAGE TEXT: Preparing review',reason:'Intentionally reproduce the historical malformed copied quote; it must not change the application outcome.'}});
   }
   if(parents===7)calls.push({name:'take_snapshot',args:{}});
   if(parents===8)calls.push({name:'prepare_application',args:{answers:[{question:'City',answer:'Sydney'}],resume_id:'cv',submit_selector:'#send'}});
   assert.equal(calls.length,1);const call=calls[0];return Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'parent-'+parents,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}]});
  };
  try{const run=await runAgentOnlyApplication({simulation:'isolated-form',page,job:{id:'sony-sequence',title:'Analyst, ANZ Data & Insights',company:'Sony Music Global Job Board',location:'Sydney',platform:'indeed',url:page.url()},profile:{name:'Fictional Candidate',email:'candidate@fixture.invalid',suburb:'Sydney',skills:[]} as never});
   assert.equal(run.outcome.status,'prepared');assert.equal(run.submitPressed,false);assert.equal(sends,0);assert.equal(await page.evaluate(()=>localStorage.getItem('sends')),null);assert.equal(reviewed,true);assert.equal(specialists,1);
   const trace=JSON.parse(readFileSync(join(directory,'traces/sony-sequence.json'),'utf8'));assert.equal(trace.steps.filter((s:any)=>s.tool==='check_specialist_recovery'&&s.disposition==='invalid-arguments').length,2);assert.ok(trace.steps.some((s:any)=>s.tool==='record_application_review'));assert.ok(trace.steps.some((s:any)=>s.tool==='prepare_application'&&s.disposition==='terminal'));
   logOutcome(outcomeFromRun(run,'sony-sequence',page.url()));
   const recorded=JSON.parse(readFileSync(join(directory,'run-log.jsonl'),'utf8').trim().split('\n').at(-1)!);
   assert.equal(recorded.status,'prepared');assert.ok(recorded.draft.id&&recorded.draft.revision,'a concrete draft was persisted through the actual run journal for dashboard import');
  }finally{await context.close();}
 });
 await test('three real failed approaches stop another repair, preserve checkpoint and remain a technical error',async()=>{
  const context=await browser.newContext(),page=await context.newPage();await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main><h1>Unavailable widget</h1><label>Answer<input id=answer type=number></label><label>Date<input id=date type=date></label><label>Choice<select id=choice><option>Available</option></select></label><button id=fourth onclick="window.fourth=true">Fourth</button></main>'}));await page.goto('https://retry-budget.fixture.invalid/application');let parents=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));if(isSpecialistFixtureRequest(body))return Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{content:JSON.stringify({advice:'Use up to three different native approaches. Preserve a technical checkpoint if none work.',evidence:[],unknowns:[],nextSteps:[],recovery_goal:{kind:'field-value',target:'Answer',value:'verified'}})}}]});
   const all=body.messages.map((m:any)=>typeof m.content==='string'?m.content:'').join('\n');const matches=[...all.matchAll(/SPECIALIST RECOVERY OBLIGATION\n([^\n]+)/g)],task=matches.length?JSON.parse(matches.at(-1)![1]):undefined;
   parents++;assert.ok(parents<=8);let call;
   if(parents===1)call={name:'consult_application_specialist',args:{question:'The widget is unavailable; preserve work after bounded different approaches.',focus:'form'}};
   else if(parents===2)call={name:'browser_action',args:{action:'fill',selector:'#answer',value:'not-a-number'}};
   else if(parents===3)call={name:'browser_action',args:{action:'fill',selector:'#date',value:'invalid-date'}};
   else if(parents===4)call={name:'browser_action',args:{action:'select',selector:'#choice',value:'Unavailable'}};
   else if(parents===5){assert.equal(task.attempts,3);call={name:'browser_action',args:{action:'click',selector:'#fourth',sends_application:false}};}
   else if(parents===6)call={name:'save_progress',args:{note:'Three distinct observed attempts failed. Preserve current form and resume inventory for a later technical retry.'}};
   else call={name:'finish',args:{status:'error',reason:'Three different native repair approaches failed; employer widget remains unavailable.',evidence:'Current page has the Answer field but no usable recovery controls.'}};
   return Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'retry-'+parents,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}]});
  };
  try{const run=await runAgentOnlyApplication({simulation:'isolated-form',page,job:{id:'retry-budget',title:'Synthetic role',company:'Fixture',location:'Sydney',platform:'workday',url:page.url()},profile:{name:'Fictional Candidate',email:'candidate@fixture.invalid',skills:[]} as never});
   assert.equal(run.outcome.status,'error');const outcome=outcomeFromRun(run,'retry-budget',page.url());assert.equal(outcome.status,'error');if(outcome.status==='error'){assert.equal(outcome.retryable,true);assert.ok(outcome.recoveryId);const db=new DatabaseSync(join(directory,'application-recovery.sqlite'));const saved=JSON.parse(String(db.prepare('SELECT state FROM recovery_records WHERE id=?').get(outcome.recoveryId)!.state));assert.equal(saved.status,'paused');assert.ok(saved.work);assert.equal(saved.controls.specialistRecovery.task.attempts.length,3);db.close();}
   const trace=JSON.parse(readFileSync(join(directory,'traces/retry-budget.json'),'utf8'));const fourth=trace.steps.find((s:any)=>s.args?.selector==='#fourth');assert.equal(fourth.execution,'not-started');assert.match(fourth.result,/three distinct/);assert.equal(run.submitPressed,false);
  }finally{await context.close();}
 });
}finally{globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();rmSync(directory,{recursive:true,force:true});}
