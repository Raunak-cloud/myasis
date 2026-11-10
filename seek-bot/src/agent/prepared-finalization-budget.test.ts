import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

test('a truncated preparation reply followed by a full request timeout recovers without sending or losing the draft', {timeout:20_000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-final-review-budget-'));
 const keys=['DATA_DIR','CELERIS_API_KEY','COST_TRACKING','FORM_CORPUS_DIR','APPLICATION_REVIEW_MODE','AGENT_BUDGET_USD','AGENT_PROGRESS_BUDGET_USD','CELERIS_QUEUE_FILE','CELERIS_MIN_INTERVAL_MS','APPLICATION_AI_MODEL'];
 const prior=keys.map(key=>process.env[key]),fetchBefore=globalThis.fetch,nowBefore=Date.now,timeoutBefore=AbortSignal.timeout;
 let elapsed=0;const windows:number[]=[];
 Date.now=()=>nowBefore()+elapsed;
 AbortSignal.timeout=ms=>{windows.push(ms);return timeoutBefore(ms);};
 Object.assign(process.env,{DATA_DIR:dir,CELERIS_API_KEY:'fixture-only',COST_TRACKING:'false',FORM_CORPUS_DIR:join(dir,'corpus'),APPLICATION_REVIEW_MODE:'prepare',AGENT_BUDGET_USD:'0.20',AGENT_PROGRESS_BUDGET_USD:'0.70',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',APPLICATION_AI_MODEL:'celeris'});
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
  let finalizationRequests=0,sequence=0;
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));sequence++;
   const packet=(name:string,args:Record<string,unknown>)=>({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`budget-${sequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
   if(sequence===1)return Response.json(packet('browser_action',{action:'fill',selector:'#name',value:'Fixture Candidate'}));
   if(sequence===2)return Response.json(packet('prepare_application',{answers:[],resume_id:'cv'}));
   finalizationRequests++;
   assert.match(JSON.stringify(body.messages),/Fixture Candidate/,'candidate sources survive recovery');
   if(finalizationRequests===1){
    assert.equal(body.chat_template_kwargs.reasoning_effort,'medium','routine preparation is not automatically escalated');
    elapsed+=31_000;
    const payload:any=packet('browser_action',{action:'click',selector:'#send',sends_application:true});
    payload.choices[0].finish_reason='length';payload.choices[0].message.content='Incomplete fixture preparation';
    payload.usage={prompt_tokens:Math.ceil(.22*1_000_000/CELERIS_RATES.promptUncached),completion_tokens:8192};
    return Response.json(payload);
   }
   assert.ok(!body.tools.some((tool:any)=>tool.function.name==='browser_action'),'a generation overrun cannot fund browser mutations from completion reserves');
   assert.ok(windows.at(-1)!>=45_000,'every recovery request gets its full inference window');
   if(finalizationRequests===2){elapsed+=45_000;throw new DOMException('Fixture inference timed out','TimeoutError');}
   assert.equal(finalizationRequests,3,'recovery must complete without a mandatory self-review turn');
   return Response.json(packet('prepare_application',{answers:[],resume_id:'cv',submit_selector:'#send'}));
  }) as typeof fetch;
  const result=await runAgentOnlyApplication({page,job,profile:{name:'Fixture Candidate',email:'',phone:'',skills:[]} as never,log:()=>{}});
  assert.equal(result.outcome.status,'prepared');assert.equal(finalizationRequests,3,'truncation and timeout recover within the original application');
  assert.equal(await page.locator('#name').inputValue(),'Fixture Candidate');assert.equal(sequence,5);
  assert.equal(await page.evaluate(()=>(window as any).sent??false),false,'preparation never sends');
 }finally{globalThis.fetch=fetchBefore;Date.now=nowBefore;AbortSignal.timeout=timeoutBefore;Object.assign(config,before);await browser.close();closeCelerisQueues();keys.forEach((key,index)=>prior[index]===undefined?delete process.env[key]:process.env[key]=prior[index]);rmSync(dir,{recursive:true,force:true});}
});
