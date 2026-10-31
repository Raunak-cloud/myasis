/** Real browser/state transitions; scripted provider replies, no paid model or real accounts. */
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';

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
type Call={name:string;args:Record<string,unknown>};
const review=(assessment='ready'):Call=>({name:'record_application_review',args:{assessment,vacancy:'Fictional developer at Fictional Employer, Sydney',
 documents:'Fictional CV and the observed fictional form.',unresolved:assessment==='ready'?[]:['The fictional candidate answer needs correction or clarification.'],
 checks:[{question:'Fictional form',source_evidence:'Controlled fixture candidate evidence',intended_meaning:'Use controlled data',observed_value:'Observed browser form',conclusion:assessment}],next_action:'Continue from the current observed page'}});
const result=(assessment='progress'):Call=>({name:'record_recovery_result',args:{assessment,evidence:['A new fictional candidate answer is saved in the current form.'],next_action:'Continue with the observed form.'}});
const finish=(status='skipped',extra:Record<string,unknown>={}):Call=>({name:'finish',args:{status,reason:'Controlled fixture outcome',evidence:'Current fictional employer state',...extra}});
const plan:Call={name:'record_recovery_plan',args:{observed_issue:'The scripted locator was invalid.',evidence:['The browser tool rejected the invalid schema.'],previous_approaches:['Invalid extra property.'],next_action:'Use a current valid browser target.',verification:'A valid operation succeeds on the observed form.'}};
const packet=(calls:Call[],cost=0)=>Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:calls.map((call,i)=>({id:'fixture-'+i,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}}],usage:{prompt_tokens:Math.round(cost*1_000_000/CELERIS_RATES.promptUncached),completion_tokens:0}});
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
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;calls++;
  if(calls===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.10);
  assert.equal(calls,2,'an unaffordable repair must not start another paid model turn');
  assert.equal(body.tool_choice?.function?.name,'record_application_review');return packet([review('correct')],.13);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'skipped');assert.match(JSON.stringify(r.outcome),/spending budget/);assert.equal(calls,2);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);}finally{await f.context.close();}
});

test('an already-generated recovery plan is saved once across the budget boundary, with no further paid plan loop',{timeout:10000},async()=>{
 const f=await fixture(form);let calls=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;calls++;
  assert.ok(calls<=3,'no fourth paid decision may be requested after the action allowance ends');
  if(calls<3)return packet([{name:'browser_action',args:{action:'click',selector:'#send',undeclared:true}}],.02);
  assert.equal(body.tool_choice?.function?.name,'record_recovery_plan');return packet([plan],.20);
 };
 try{const r=await runAgentOnlyApplication(f);assert.match(JSON.stringify(r.outcome),/spending budget/);assert.equal(calls,3);
  const trace=JSON.parse(readFileSync(join(directory,'traces',f.job.id+'.json'),'utf8'));
  const saved=trace.steps.find((step:any)=>step.tool==='record_recovery_plan');assert.match(saved.result,/plan is recorded/);assert.doesNotMatch(saved.result,/Not run/);
 }finally{await f.context.close();}
});

test('fresh progress verification can use its reserve and fund the next productive decision',{timeout:10000},async()=>{
 const f=await fixture(form);let calls=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;calls++;
  if(calls===1)return packet([{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fictional Candidate'}}],.19);
  if(calls===2)return packet([{name:'take_snapshot',args:{}}],.08);
  if(calls===3){assert.equal(body.tool_choice?.function?.name,'record_recovery_result');return packet([result()],.04);}
  assert.equal(calls,4);return packet([finish()]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.deepEqual(r.outcome,{status:'skipped',reason:'Controlled fixture outcome'});assert.equal(calls,4);}finally{await f.context.close();}
});

test('a post-send specialist charge leaves one receipt-only record, never another send',{timeout:10000},async()=>{
 const f=await fixture(form);let turns=0,specialists=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;
  if(!body.tools?.length){specialists++;return Response.json({choices:[{message:{content:JSON.stringify({advice:'Inspect the actual receipt.',evidence:[],unknowns:[],nextSteps:[]})}}],usage:{prompt_tokens:150000,completion_tokens:0}});}
  turns++;
  if(turns===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.01);
  if(turns===2)return packet([review()],.01);
  if(turns===3)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},{name:'consult_application_specialist',args:{question:'What does the current fictional receipt mean?'}}],.17);
  assert.equal(turns,4);assert.deepEqual(body.tools?.map(tool=>tool.function.name),['finish']);assert.equal(body.tool_choice?.function?.name,'finish');
  return packet([finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})],.03);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'applied');assert.equal(r.submitPressed,true);assert.equal(specialists,1);assert.equal(turns,4);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1);}finally{await f.context.close();}
});

test('a final-record-only reply cannot retry a send or claim the skipped retry succeeded',{timeout:10000},async()=>{
 const f=await fixture(form);let turns=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;
  if(!body.tools?.length)return Response.json({choices:[{message:{content:JSON.stringify({advice:'Use the existing evidence.',evidence:[],unknowns:[],nextSteps:[]})}}],usage:{prompt_tokens:150000,completion_tokens:0}});
  turns++;
  if(turns===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}],.01);
  if(turns===2)return packet([review()],.01);
  if(turns===3)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},{name:'consult_application_specialist',args:{question:'Read the current fictional page.'}}],.17);
  assert.equal(turns,4,'an unusable terminal record must not trigger another paid attempt');assert.deepEqual(body.tools?.map(tool=>tool.function.name),['finish']);
  return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'skipped');assert.equal(r.submitPressed,true);assert.equal(turns,4);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1);}finally{await f.context.close();}
});

test('Semi auto preparation, exact approval and changed-answer reapproval keep their confirmation boundaries',{timeout:10000},async()=>{
 const f=await fixture(form);process.env.APPLICATION_REVIEW_MODE='prepare';let turns=0;
 const prepare:Call={name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}};
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  if(body.tool_choice?.function?.name==='record_application_review')return packet([review()]);
  if(turns===1)return packet([{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fictional Candidate'}}]);
  assert.ok(turns<=4);return packet([prepare]);
 };
 try{
  const prepared=await runAgentOnlyApplication(f);assert.equal(prepared.outcome.status,'prepared');assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);
  if(prepared.outcome.status!=='prepared')throw Error('Expected a candidate-review draft');
  writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([prepared.outcome.draft]));process.env.APPLICATION_REVIEW_MODE='approved';turns=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
   if(body.tool_choice?.function?.name==='record_application_review')return packet([review()]);
   if(turns<=3)return packet([prepare]);
   if(turns===4)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}]);
   assert.equal(turns,5);return packet([finish('applied',{receipt:{quote:'Application received: BUDGET-FIX'}})]);
  };
  const approved=await runAgentOnlyApplication(f);assert.equal(approved.outcome.status,'applied');assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1);
  await f.page.evaluate(html=>{document.body.innerHTML=html;},form);await f.page.locator('#name').fill('Changed candidate answer');turns=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;assert.ok(turns<=3);return packet([body.tool_choice?.function?.name==='record_application_review'?review():prepare]);};
  const changed=await runAgentOnlyApplication(f);assert.equal(changed.outcome.status,'prepared');assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),1,'changed content cannot send using the old confirmation');
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

test('email preparation retains an already-paid draft and changes to its recipient require a fresh agent review',{timeout:10000},async()=>{
 const f=await fixture('<main>Apply by email to first@fixture.invalid or second@fixture.invalid, with a cover letter and resume.</main>');let turns=0,reviews=0;
 const draft=(to:string):Call=>({name:'prepare_email_application',args:{to,subject:'Fictional application',cover_letter:'Dear team,\n\nI am applying using my fictional candidate CV.\n\nFictional Candidate',resume_id:'cv'}});
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;
  assert.ok(turns<=5,'the exact local email draft must not be discarded or repeatedly regenerated');
  if(body.tool_choice?.function?.name==='record_application_review'){reviews++;return packet([review()]);}
  return packet([draft(turns===1?'first@fixture.invalid':'second@fixture.invalid')],turns===5?.25:.01);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'prepared');assert.equal(reviews,2);assert.equal(turns,5);assert.equal(r.submitPressed,false);if(r.outcome.status==='prepared')assert.equal(r.outcome.draft.email?.to,'second@fixture.invalid');}finally{await f.context.close();}
});

test('cleanup failure cannot overwrite a completed result or the primary provider error',{timeout:10000},async()=>{
 const f=await fixture(form);config.dryRun=true;
 const unroute=f.context.unroute.bind(f.context);f.context.unroute=async()=>{throw new Error('Fictional cleanup failure');};
 try{
  globalThis.fetch=async()=>packet([finish()]);
  const r=await runAgentOnlyApplication({...f,simulation:'isolated-form'});assert.equal(r.outcome.status,'rehearsed');assert.match(r.usage,/1 calls/);
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
  if(turns===2){assert.equal(body.tool_choice?.function?.name,'record_application_review');return packet([{name:'record_application_review',args:{assessment:'ready'}}],.08);}
  if(turns===3){assert.equal(body.tool_choice?.function?.name,'record_application_review');return packet([review()],.15);}
  assert.equal(turns,4,'only the completed local draft should follow the corrected review');return packet([prepare]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.equal(r.outcome.status,'prepared');assert.equal(turns,4);assert.equal(r.submitPressed,false);}finally{process.env.APPLICATION_REVIEW_MODE='';await f.context.close();}
});

test('repeated malformed final review exits with its actual error instead of looping through send again',{timeout:10000},async()=>{
 const f=await fixture(form);let turns=0;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Body;turns++;assert.ok(turns<=3,'no paid send/review loop is allowed after an unusable correction');
  if(turns===1)return packet([{name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}}]);
  assert.equal(body.tool_choice?.function?.name,'record_application_review');return packet([{name:'record_application_review',args:{assessment:'ready'}}]);
 };
 try{const r=await runAgentOnlyApplication(f);assert.deepEqual(r.outcome,{status:'skipped',reason:'The application could not be completed.'});assert.equal(turns,3);assert.equal(r.submitPressed,false);assert.equal(await f.page.evaluate(()=>Number(document.documentElement.dataset.sent||0)),0);}finally{await f.context.close();}
});
