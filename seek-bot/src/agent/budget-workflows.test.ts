/** Real browser/state transitions; scripted provider replies, no paid model or real accounts. */
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {specialistFixtureReply,isSpecialistFixtureRequest} from './specialist-fixture.js';

const directory=mkdtempSync(join(tmpdir(),'owtomate-budget-workflows-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fictional-key',COST_TRACKING:'false',FORM_CORPUS_DIR:join(directory,'corpus'),
 ALLOW_EXTERNAL_APPLY:'true',DRY_RUN:'false',APPLICATION_REVIEW_MODE:'',AGENT_BUDGET_USD:'0.20',AGENT_PROGRESS_BUDGET_USD:'0.70',
 GMAIL_MCP_URL:'http://127.0.0.1:1/fixture-only',GMAIL_MCP_TOKEN:'fictional-token',GMAIL_MCP_ACCOUNT:'candidate@fixture.invalid'});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','CV.txt'),'Fictional Candidate. Fictional evidence only.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fictional CV',fileName:'CV.txt'}]));
const {runAgentOnlyApplication}=await import('./agent-only.js');
const {config}=await import('../config.js');
const {CELERIS_RATES}=await import('../cost-ledger.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
const fetchBefore=globalThis.fetch;
after(async()=>{globalThis.fetch=fetchBefore;await browser.close();rmSync(directory,{recursive:true,force:true});});
type Body={tools?:Array<{function:{name:string}}>;tool_choice?:{function?:{name?:string}};messages:unknown[]};
const reviewAdvice=(body:Body)=>String((body.messages.at(-1) as {content?:unknown})?.content??'').startsWith('APPLICATION REVIEW ADVICE:');
type Call={name:string;args:Record<string,unknown>};
const review=(assessment='ready'):Call=>({name:'record_application_review',args:{assessment,vacancy:'Fictional developer at Fictional Employer, Sydney',
 documents:'Fictional CV and the observed fictional form.',unresolved:assessment==='ready'?[]:['The fictional candidate answer needs correction or clarification.'],
 checks:[{question:'Fictional form',source_evidence:'Controlled fixture candidate evidence',intended_meaning:'Use controlled data',observed_value:'Observed browser form',conclusion:assessment}],next_action:'Continue from the current observed page'}});
const result=(assessment='progress'):Call=>({name:'record_recovery_result',args:{assessment,evidence:['A new fictional candidate answer is saved in the current form.'],next_action:'Continue with the observed form.'}});
const finish=(status='skipped',extra:Record<string,unknown>={}):Call=>({name:'finish',args:{status,reason:'Controlled fixture outcome',evidence:'Current fictional employer state',...extra}});
const plan:Call={name:'record_recovery_plan',args:{observed_issue:'The scripted locator was invalid.',evidence:['The browser tool rejected the invalid schema.'],previous_approaches:['Invalid extra property.'],next_action:'Use a current valid browser target.',verification:'A valid operation succeeds on the observed form.'}};
let packetSequence=0;
const packet=(calls:Call[],cost=0)=>Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:calls.map((call,i)=>({id:'fixture-'+ ++packetSequence+'-'+i,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}}],usage:{prompt_tokens:Math.round(cost*1_000_000/CELERIS_RATES.promptUncached),completion_tokens:0}});
let sequence=0;
async function fixture(html:string){
 process.env.APPLICATION_REVIEW_MODE='';config.dryRun=false;config.allowExternalApply=true;
 config.celeris.budgetUsdPerApplication=.20;config.celeris.progressBudgetUsdPerApplication=.70;
 const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
 const page=await context.newPage();const job={id:'budget-workflow-'+ ++sequence,title:'Fictional developer',company:'Fictional Employer',location:'Sydney',url:'https://form.fixture.invalid/apply',platform:'seek' as const};
 await page.goto(job.url);return {context,page,job,profile:{name:'Fictional Candidate',email:'candidate@fixture.invalid',phone:'',skills:[]} as never,log:()=>{}};
}
const form='<main><label>Name<input id="name"></label><button id="send" onclick="document.documentElement.dataset.sent=String(Number(document.documentElement.dataset.sent||0)+1);document.querySelector(\'main\').textContent=\'Application received: BUDGET-FIX\'">Submit application</button></main>';

test('Auto apply returns from canonical correction to work without spending the old review reserve',{timeout:10000},async()=>{
 const f=await fixture(form);let calls=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;const specialist=specialistFixtureReply(body);if(specialist)return specialist;calls++;
  if(calls===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.10);
  assert.equal(calls,2,'an unaffordable repair must not start another paid model turn');
  assert.equal(body.tool_choice?.function?.name,undefined,'a review report is never forced');return packet([review('correct')],.13);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'error');assert.match(JSON.stringify(r.outcome),/spending budget/);assert.equal(calls,2);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);}finally{await f.context.close();}
});

test('an already-generated recovery plan is saved once across the budget boundary, with no further paid plan loop',{timeout:10000},async()=>{
 const f=await fixture(form);let calls=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;const specialist=specialistFixtureReply(body);if(specialist)return specialist;calls++;
  assert.ok(calls<=3,'no fourth paid decision may be requested after the action allowance ends');
  if(calls<3)return packet([{name:'browser_action',args:{action:'click',selector:'#send',undeclared:true}}],.02);
  assert.equal(body.tool_choice?.function?.name,undefined,'recovery notes cannot exclude normal tools');return packet([plan],.20);
 };
 try{const r=await runAgentOnlyApplication(f);assert.match(JSON.stringify(r.outcome),/spending budget/);assert.equal(calls,3);
  const trace=JSON.parse(readFileSync(join(directory,'traces',f.job.id+'.json'),'utf8'));
  const saved=trace.steps.find((step:any)=>step.tool==='record_recovery_plan');assert.match(saved.result,/plan is recorded/);assert.doesNotMatch(saved.result,/Not run/);
 }finally{await f.context.close();}
});

test('fresh progress verification can use its reserve and fund the next productive decision',{timeout:10000},async()=>{
 const f=await fixture(form);let calls=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;const specialist=specialistFixtureReply(body);if(specialist)return specialist;calls++;
  if(calls===1)return packet([{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fictional Candidate'}}],.19);
  if(calls===2)return packet([{name:'browser_action',args:{action:'take_snapshot'}}],.08);
  if(calls===3){assert.equal(body.tool_choice?.function?.name,undefined,'progress review is advisory');return packet([result()],.04);}
  assert.equal(calls,4);return packet([finish()]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.deepEqual(r.outcome,{status:'skipped',reason:'Controlled fixture outcome'});assert.equal(calls,4);}finally{await f.context.close();}
});

test('a final-record-only reply cannot retry a send or claim the skipped retry succeeded',{timeout:10000},async()=>{
 const f=await fixture(form);let turns=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;
  if(isSpecialistFixtureRequest(body))return packet([{name:'return_application_advice',args:{advice:'Use the existing evidence.',evidence:[],unknowns:[],nextSteps:[],recovery_goal:{kind:'visible-text',target:'Application received: BUDGET-FIX',value:'Application received: BUDGET-FIX'}}}],.03);
  turns++;
  if(turns===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.01);
  if(turns===2)return packet([review()],.01);
  if(turns===3)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.17);
  if(turns===4)return packet([{name:'browser_action',args:{action:'inspect',selector:'body'}}],.03);
  assert.equal(turns,5,'an unusable terminal record must not trigger another paid attempt');assert.deepEqual(body.tools?.map(tool=>tool.function.name),['finish']);
  return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'error');assert.equal(r.submitPressed,true);assert.equal(turns,5);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1);}finally{await f.context.close();}
});

test('Semi auto preparation, exact approval and in-place answer repair keep their confirmation boundaries',{timeout:10000},async()=>{
 const f=await fixture(form);process.env.APPLICATION_REVIEW_MODE='prepare';let turns=0;
 const prepare:Call={name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}};
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  if(reviewAdvice(body))return packet([review()]);
  if(turns===1)return packet([{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fictional Candidate'}}]);
  assert.ok(turns<=4);return packet([prepare]);
 };
 try{
  const prepared=await runAgentOnlyApplication(f);assert.equal(prepared.outcome.status,'prepared');assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);
  if(prepared.outcome.status!=='prepared')throw Error('Expected a candidate-review draft');
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([prepared.outcome.draft]));process.env.APPLICATION_REVIEW_MODE='approved';turns=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
   if(reviewAdvice(body))return packet([review()]);
   if(turns<=3)return packet([prepare]);
   if(turns===4)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}]);
   assert.equal(turns,5);return packet([finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})]);
  };
  const approved=await runAgentOnlyApplication(f);assert.equal(approved.outcome.status,'applied');assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1);
  await f.page.evaluate(html=>{document.body.innerHTML=html;document.addEventListener('click',event=>{
   if((event.target as Element).closest('#send'))document.documentElement.dataset.sentName=(document.querySelector('#name') as HTMLInputElement)?.value;
  },true);},form);await f.page.locator('#name').fill('Changed candidate answer');turns=0;
  const approvalBefore=readFileSync(join(directory,'approved-applications.json'),'utf8');
  let repairPhase:'blocked'|'restored'|'receipt'|'done'='blocked';
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;assert.ok(turns<=10,'bounded correction must complete without a re-preparation loop');
   if(reviewAdvice(body))return packet([review()]);
   const lastTool=(body.messages as Array<{role?:string;content?:unknown}>).filter(message=>message.role==='tool').at(-1);
   if(repairPhase==='blocked'){
    if(!String(lastTool?.content).includes('differs from the approved text'))return packet([prepare]);
    assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1,'changed content never transmits');
    repairPhase='restored';return packet([{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fictional Candidate'}}]);
   }
   if(repairPhase==='restored'){
    if(!String(lastTool?.content).includes('Candidate approval and document checks passed'))return packet([prepare]);
    repairPhase='receipt';return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}]);
   }
   assert.equal(repairPhase,'receipt','one repaired send is followed only by receipt verification');
   repairPhase='done';return packet([finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})]);
  };
  const changed=await runAgentOnlyApplication(f);assert.equal(changed.outcome.status,'applied');assert.equal(repairPhase,'done');
  assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),2,'exactly one corrected submission follows the earlier approved submission');
  assert.equal(await f.page.evaluate(()=>document.documentElement.dataset.sentName),'Fictional Candidate','the actual click carries the restored approved value');
  assert.equal(readFileSync(join(directory,'approved-applications.json'),'utf8'),approvalBefore,'in-place recovery retains the exact candidate approval');
 }finally{process.env.APPLICATION_REVIEW_MODE='';await f.context.close();}
});

test('required missing answers can be recorded after the paid canonical review crosses the action allowance',{timeout:10000},async()=>{
 const f=await fixture('<main><label>What is your visa expiry date?<input type="date" required></label><button id="send">Submit application</button></main>');let turns=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  if(turns===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.01);
  if(turns===2)return packet([review('needs_answer')],.20);
  assert.equal(turns,3);assert.deepEqual(body.tools?.map(tool=>tool.function.name),['finish']);
  return packet([finish('needs-human',{questions:[{field_ref:'f0',form_quote:'What is your visa expiry date?',kind:'text'}]})]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'needs-human');assert.equal(turns,3);assert.equal(r.submitPressed,false);if(r.outcome.status==='needs-human')assert.equal(r.outcome.questions?.[0].question,'What is your visa expiry date?');}finally{await f.context.close();}
});

test('a stale question reference receives recoverable feedback and the current grounded question is saved without a send',{timeout:10000},async()=>{
 const f=await fixture('<main><label>Required detail<input required></label><button id="send">Submit application</button></main>');let turns=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body)) as Body;const recoveryReply=specialistFixtureReply(body);if(recoveryReply)return recoveryReply;
  turns++;assert.ok(turns<=2,'one corrected reference must finish without a recovery loop');
  if(turns===1)return packet([finish('needs-human',{questions:[{field_ref:'f999',form_quote:'Required detail',kind:'text'}]})]);
  const latest=(body.messages as Array<{role:string;content:string}>).filter(m=>m.role==='tool').at(-1)?.content;
  assert.match(latest??'',/Nothing was submitted or saved for attention.*native FIELD ref/);
  return packet([finish('needs-human',{questions:[{field_ref:'f0',form_quote:'Required detail',kind:'text'}]})]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'needs-human');assert.equal(turns,2);assert.equal(r.submitPressed,false);
  if(r.outcome.status==='needs-human')assert.equal(r.outcome.questions?.[0].question,'Required detail');
  assert.equal(await f.page.locator('input').inputValue(),'','recovery does not invent the missing answer');
 }finally{await f.context.close();}
});

test('email preparation retains an already-paid draft and changes to its recipient require a fresh agent review',{timeout:10000},async()=>{
 const f=await fixture('<main>Apply by email to first@fixture.invalid or second@fixture.invalid, with a cover letter and resume.</main>');let turns=0,reviews=0;
 const draft=(to:string):Call=>({name:'prepare_email_application',args:{to,subject:'Fictional application',cover_letter:'Dear team,\n\nI am applying using my fictional candidate CV.\n\nFictional Candidate',resume_id:'cv'}});
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  assert.ok(turns<=5,'the exact local email draft must not be discarded or repeatedly regenerated');
  if(reviewAdvice(body)){reviews++;return packet([review()]);}
  return packet([draft(turns===1?'first@fixture.invalid':'second@fixture.invalid')],turns===5?.25:.01);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'prepared');assert.equal(reviews,2);assert.equal(turns,5);assert.equal(r.submitPressed,false);if(r.outcome.status==='prepared')assert.equal(r.outcome.draft.email?.to,'second@fixture.invalid');}finally{await f.context.close();}
});

test('cleanup failure cannot overwrite a completed result or the primary provider error',{timeout:10000},async()=>{
 const f=await fixture(form);config.dryRun=true;
 const unroute=f.context.unroute.bind(f.context);f.context.unroute=async()=>{throw new Error('Fictional cleanup failure');};
 try{
  let requests=0,specialists=0;
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body)) as Body;requests++;
   assert.ok(requests<=3,'advisory recovery must not require extra reporting turns before the agent can stop');
   assert.ok(!['respond_to_specialist','check_specialist_recovery'].includes(body.tool_choice?.function?.name??''),'specialist reports cannot be forced');
   const specialist=specialistFixtureReply(body);if(isSpecialistFixtureRequest(body))specialists++;
   const response=await (specialist??packet([finish()])).json();
   response.usage={prompt_tokens:Math.round(.01*1_000_000/CELERIS_RATES.promptUncached),completion_tokens:0};
   return Response.json(response);
  };
  const r=await runAgentOnlyApplication({...f,simulation:'isolated-form'});assert.equal(r.outcome.status,'rehearsed');assert.equal(specialists,0);
  assert.ok(r.usage.startsWith(`${requests} calls ·`),'every actual applying-agent request remains on the same meter');
  assert.ok(r.usage.endsWith(`$${(requests*.01).toFixed(5)}`),'the shared meter retains applying-agent costs despite cleanup failure');
  globalThis.fetch=async()=>new Response('Fictional provider rejection',{status:400});
  await assert.rejects(()=>runAgentOnlyApplication({...f,job:{...f.job,id:f.job.id+'-provider'},simulation:'isolated-form'}),/Fictional provider rejection/);
  const diagnostics=readdirSync(join(directory,'traces')).filter(name=>name.endsWith('.diagnostics.jsonl')).map(name=>readFileSync(join(directory,'traces',name),'utf8')).join('\n');
  assert.match(diagnostics,/cleanup_error/);
 }finally{f.context.unroute=unroute;await f.context.close();config.dryRun=false;}
});

test('malformed final review retries the same assessment once without pretending the form needs edits',{timeout:10000},async()=>{
 const f=await fixture(form);process.env.APPLICATION_REVIEW_MODE='prepare';let turns=0;
 const prepare:Call={name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}};
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  if(turns===1)return packet([prepare]);
  if(turns===2){assert.equal(body.tool_choice?.function?.name,undefined,'a review report is never forced');return packet([{name:'record_application_review',args:{assessment:'ready'}}],.08);}
  if(turns===3){assert.equal(body.tool_choice?.function?.name,undefined,'a review report is never forced');return packet([review()],.15);}
  assert.equal(turns,4,'only the completed local draft should follow the corrected review');return packet([prepare]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'prepared');assert.equal(turns,4);assert.equal(r.submitPressed,false);}finally{process.env.APPLICATION_REVIEW_MODE='';await f.context.close();}
});

test('repeated malformed optional reviews cannot force a skip or stop normal preparation',{timeout:10000},async()=>{
 const f=await fixture(form);process.env.APPLICATION_REVIEW_MODE='prepare';let turns=0;
 const prepare:Call={name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}};
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;assert.ok(turns<=4,'no mandatory reporting loop');
  assert.equal(body.tool_choice?.function?.name,undefined,'normal tools remain available after malformed optional reports');
  if(turns===1||turns===4)return packet([prepare]);
  return packet([{name:'record_application_review',args:{assessment:'ready'}}]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'prepared');assert.equal(turns,4);assert.equal(r.submitPressed,false);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);
  const trace=JSON.parse(readFileSync(join(directory,'traces',f.job.id+'.json'),'utf8'));assert.equal(trace.steps.filter((step:any)=>step.tool==='record_application_review'&&step.disposition==='advisory').length,2);
 }finally{process.env.APPLICATION_REVIEW_MODE='';await f.context.close();}
});
