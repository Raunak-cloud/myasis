// Real configured model; fictional candidate, isolated .invalid forms and temp data.
// Each case is a separate process because application mode is process-scoped.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
if(!process.argv.includes('--live'))throw Error('Pass --live for a bounded real-model rehearsal.');
const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const id=argument('--case');
const cases={
  'guided-auto-celeris':{provider:'celeris',mode:'',guided:true},
  'guided-semi-celeris':{provider:'celeris',mode:'prepare',guided:true},
  'guided-auto-minimax':{provider:'minimax',mode:'',guided:true},
  'guided-semi-minimax':{provider:'minimax',mode:'prepare',guided:true},
  'autonomous-celeris':{provider:'celeris',mode:'',guided:false},
  'documents-celeris':{provider:'celeris',mode:'',guided:true,documents:true},
};
const fixture=cases[id];if(!fixture)throw Error('Unknown --case.');
const botRoot=process.env.OWTOMATE_TEST_BOT_ROOT||fileURLToPath(new URL('../',import.meta.url));
const output=resolve(argument('--output')||join(botRoot,'output','helper-live',id));mkdirSync(output,{recursive:true});
const directory=mkdtempSync(join(tmpdir(),'helper-live-'));
Object.assign(process.env,{DATA_DIR:directory,DRY_RUN:'false',COST_TRACKING:'false',ALLOW_EXTERNAL_APPLY:'true',APPLICATION_REVIEW_MODE:fixture.mode,
  APPLICATION_AI_MODEL:fixture.provider,APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',FORM_CORPUS_DIR:join(directory,'corpus'),
  CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',OWTOMATE_LIVE_REPAIR:'',
  RESUME_SELECT:'cv',KEYWORDS:'software developer',TARGET_ROLE:'',AI_INSTRUCTIONS_B64:'',COVER_LETTER_MODE:'tailored',
  COVER_LETTER_TEXT_B64:'',COVER_LETTER_INSTRUCTIONS:'',AGENT_BUDGET_USD:'0.35',AGENT_PROGRESS_BUDGET_USD:'0.35'});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','CV.txt'),'Alex Fixture. Australian citizen based in Sydney. Software developer with two years of TypeScript and React experience. alex@example.invalid.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fictional CV',fileName:'CV.txt',isDefault:true}]));
const {config}=await import(pathToFileURL(join(botRoot,'dist/config.js')).href);
// dotenv has now loaded the model credentials. Disable unrelated connectors.
for(const key of Object.keys(process.env))if(/^(GMAIL_MCP_|GOOGLE_|OWTOMATE_RUN_START_ID)/.test(key))delete process.env[key];
const {withApplicationModel}=await import(pathToFileURL(join(botRoot,'dist/application-model.js')).href);
const {runAgentOnlyApplication}=await import(pathToFileURL(join(botRoot,'dist/agent/agent-only.js')).href);
const {closeCelerisQueues}=await import(pathToFileURL(join(botRoot,'../shared/celeris-queue.mjs')).href);
const {chromium}=await import(pathToFileURL(join(botRoot,'node_modules/patchright/index.mjs')).href);
const originalFetch=globalThis.fetch,started=Date.now();let browser;
const report={case:id,fixture,kind:'real-model',systemPromptChanged:false,realEmployerSubmissions:0,budgetUsd:.35,
  modelRequests:0,toolCalls:[],feedback:[],browserRequests:[],blockedExternalBrowserRequests:0};
const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();void browser?.close();},210000);
try{
  if(!(fixture.provider==='celeris'?process.env.CELERIS_API_KEY:process.env.OPENROUTER_API_KEY))throw Error('Selected model credentials unavailable.');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const url=`https://helper-rehearsal.invalid/${id}`;
  const rows=['Primary','Emergency','Payroll'].map((label,index)=>`<fieldset><legend>${label} contact record</legend>
    <label>Full name<input id=name-${index} required></label><label>Email<input id=email-${index} required type=email></label>
    <label>City<input id=city-${index} required></label></fieldset>`).join('');
  const profile={name:'Alex Fixture',email:'alex@example.invalid',phone:'',nationality:'Australian',workRights:'Australian citizen',
    city:'Sydney',suburb:'Sydney',skills:['TypeScript','React'],experienceSummary:'Two years of TypeScript and React software development. Lives in Sydney, Australia.',excludedDomains:[]};
  const html=`<!doctype html><main><h1>Software Developer</h1><p>Fictional Employer, Sydney. Isolated test.</p>
    <p>${fixture.documents?'Upload a PDF supporting statement containing the candidate name, city and development skills. A resume and cover letter are not requested in this test.':'For this fictional form all three records refer to the applicant. Enter the same applicant name, email and city in each. No resume or cover letter is requested.'}</p>
    <form onsubmit="event.preventDefault();localStorage.setItem('sends',String(Number(localStorage.getItem('sends')||0)+1));localStorage.setItem('sent',JSON.stringify([...document.querySelectorAll('input')].map(i=>({id:i.id,value:i.value,files:[...(i.files||[])].map(f=>({name:f.name,size:f.size}))}))));document.querySelector('main').innerHTML='<h1>Application received</h1><p>Receipt HELPER-${id}</p>'">
    ${fixture.documents?'<label>Supporting statement PDF<input id=supporting-file type=file accept=.pdf required></label>':rows}
    <button id=send>Submit application</button></form></main>`;
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>{
    if(route.request().url()===url){report.browserRequests.push({method:route.request().method(),url});return route.fulfill({contentType:'text/html',body:html});}
    report.blockedExternalBrowserRequests++;return route.abort();
  });
  await page.goto(url);await context.addCookies([{name:'candidate-secret',value:'fictional-private-state',url}]);
  await page.evaluate(()=>localStorage.setItem('candidate-secret','fictional-private-state'));
  const seenFeedback=new Set();
  const endpoint=fixture.provider==='celeris'?new URL(process.env.CELERIS_BASE_URL||'https://inference.celeris.ai').origin:'https://openrouter.ai';
  globalThis.fetch=async(input,init)=>{
    const requested=new URL(String(input));if(requested.origin!==endpoint)throw Error('Unexpected non-model API request blocked by rehearsal.');
    const body=JSON.parse(String(init?.body));report.modelRequests++;
    if(report.modelRequests>24)throw Error('Rehearsal request limit reached.');
    for(const message of body.messages||[])if(message.role==='tool'&&!seenFeedback.has(message.tool_call_id)){
      seenFeedback.add(message.tool_call_id);report.feedback.push({id:message.tool_call_id,content:message.content});
    }
    if(fixture.guided&&body.tools?.some(tool=>tool.function.name==='test_application_helper')){
      // A disclosed fixture instruction asks the real model to design its own
      // helper. No recipe, tool call, answer or successful result is injected.
      body.messages.push({role:'user',content:fixture.documents
        ?'SIMULATION TASK: Exercise your temporary-tool capability by designing, testing and using a temporary helper that creates and converts the supporting statement to PDF. Choose its implementation and fixture yourself. Then attach the resulting file and complete this fictional application.'
        :'SIMULATION TASK: Exercise your temporary-tool capability by designing, testing and using a reusable helper for one repeated contact record. Choose the recipe, parameters and fixture yourself, then reuse the published helper for the three records and complete this fictional application.'});
    }
    const response=await originalFetch(input,{...init,body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])});
    if(response.ok){
      const value=await response.clone().json();
      for(const call of value.choices?.[0]?.message?.tool_calls||[])report.toolCalls.push({id:call.id,name:call.function.name,arguments:call.function.arguments});
    }
    return response;
  };
  const result=await withApplicationModel({...process.env},()=>runAgentOnlyApplication({page,
    job:{id:`helper-live-${id}`,title:'Software Developer',company:'Fictional Employer',location:'Sydney',platform:'workday',url,source:'chosen',description:'Fictional TypeScript and React role in Sydney. Complete only the isolated test form.'},profile,log:line=>console.log(line)}));
  report.outcome=result.outcome;report.steps=result.steps;report.usage=result.usage;
  report.sends=await page.evaluate(()=>Number(localStorage.getItem('sends')||0));
  report.saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('sent')||'null')||[...document.querySelectorAll('input')].map(i=>({id:i.id,value:i.value,files:[...(i.files||[])].map(f=>({name:f.name,size:f.size}))})));
  report.builderCalls=report.toolCalls.filter(call=>call.name==='test_application_helper').length;
  report.helperCalls=report.toolCalls.filter(call=>call.name.startsWith('helper_')).length;
  report.helperSuccesses=report.feedback.filter(item=>{
    try{const value=JSON.parse(item.content);return typeof value.helper==='string'&&value.completedSteps>0&&value.stoppedStep===undefined&&!value.continuation&&/Helper operations completed/.test(value.note||'');}catch{return false;}
  }).length;
  assert.equal(result.outcome.status,fixture.mode?'prepared':'applied',JSON.stringify(result.outcome));
  assert.equal(report.sends,fixture.mode?0:1);
  if(fixture.guided){assert.ok(report.builderCalls>0,'The real model did not create a helper.');assert.ok(report.helperSuccesses>0,'The real model did not successfully execute its helper.');}
  if(fixture.documents){assert.equal(report.saved[0].files.length,1);assert.match(report.saved[0].files[0].name,/\.pdf$/i);assert.ok(report.saved[0].files[0].size>100);}
  else for(let index=0;index<3;index++)for(const [field,expected] of Object.entries({name:'Alex Fixture',email:'alex@example.invalid',city:'Sydney'}))assert.equal(report.saved.find(item=>item.id===`${field}-${index}`)?.value,expected);
  report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
finally{
  clearTimeout(timer);globalThis.fetch=originalFetch;await browser?.close().catch(()=>{});closeCelerisQueues();
  report.elapsedMs=Date.now()-started;
  const trace=join(directory,'traces',`helper-live-${id}.json`);if(existsSync(trace))writeFileSync(join(output,'trace.json'),readFileSync(trace));
  writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({case:id,passed:report.passed,status:report.outcome?.status,builderCalls:report.builderCalls,helperCalls:report.helperCalls,error:report.error,elapsedMs:report.elapsedMs}));
  rmSync(directory,{recursive:true,force:true});
}
