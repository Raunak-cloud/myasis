import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {createReadinessFixtureReply} from './readiness-fixture.js';

test('a truncated final self-review can recover and preserve the prepared draft below the hard ceiling', {timeout:20_000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-final-review-budget-'));
 const keys=['DATA_DIR','CELERIS_API_KEY','COST_TRACKING','FORM_CORPUS_DIR','APPLICATION_REVIEW_MODE','AGENT_BUDGET_USD','AGENT_PROGRESS_BUDGET_USD'];
 const prior=keys.map(key=>process.env[key]),fetchBefore=globalThis.fetch;
 Object.assign(process.env,{DATA_DIR:dir,CELERIS_API_KEY:'fixture-only',COST_TRACKING:'false',FORM_CORPUS_DIR:join(dir,'corpus'),APPLICATION_REVIEW_MODE:'prepare',AGENT_BUDGET_USD:'0.20',AGENT_PROGRESS_BUDGET_USD:'0.70'});
 const {config}=await import('../config.js');
 const before={dryRun:config.dryRun,allowExternalApply:config.allowExternalApply};
 config.dryRun=false;config.allowExternalApply=true;
 mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes','CV.txt'),'Fictional Fixture Candidate.');
 writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const {CELERIS_RATES}=await import('../cost-ledger.js');
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main><label>Name<input id="name"></label><button type="button" id="send" onclick="window.sent=true">Send application</button></main>'}):route.abort());
  const job={id:'final-review-budget',title:'Fictional developer',company:'Fixture',location:'Exampletown',platform:'seek' as const,url:'https://form.fixture.invalid/apply'};
  await page.goto(job.url);
  const calls=[{name:'browser_action',args:{action:'fill',selector:'#name',value:'Fixture Candidate'}},{name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}}];
  const readiness=createReadinessFixtureReply();let truncated=false,reviewRequests=0,sequence=0;
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const review=readiness(body);
   if(review){
    if(body.tool_choice?.function?.name==='record_application_review'){
     reviewRequests++;
     if(!truncated){truncated=true;const payload=await review.json();payload.choices[0].finish_reason='length';payload.choices[0].message.tool_calls=[];payload.choices[0].message.content='Incomplete fixture self-review';payload.usage={prompt_tokens:Math.ceil(.22*1_000_000/CELERIS_RATES.promptUncached),completion_tokens:8192};return Response.json(payload);}
    }
    return review;
   }
   const call=calls.shift();assert.ok(call,'no unexpected continuation');
   return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`budget-${++sequence}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
  }) as typeof fetch;
  const result=await runAgentOnlyApplication({page,job,profile:{name:'Fixture Candidate',email:'',phone:'',skills:[]} as never,log:()=>{}});
  assert.equal(result.outcome.status,'prepared');assert.equal(reviewRequests,2,'one bounded resample repairs the truncated review');
  assert.equal(await page.evaluate(()=>(window as any).sent??false),false,'preparation never sends');
 }finally{globalThis.fetch=fetchBefore;Object.assign(config,before);await browser.close();keys.forEach((key,index)=>prior[index]===undefined?delete process.env[key]:process.env[key]=prior[index]);rmSync(dir,{recursive:true,force:true});}
});
