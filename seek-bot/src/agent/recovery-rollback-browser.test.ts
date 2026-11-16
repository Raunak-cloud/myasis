import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

test('the agent can recover after repeated invalid calls and unchanged inspections without the removed screenshot cutoff',{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'owtomate-recovery-rollback-')),saved={...process.env},originalFetch=globalThis.fetch;
 Object.assign(process.env,{DATA_DIR:directory,APPLICATION_AI_MODEL:'minimax',OPENROUTER_API_KEY:'fixture-only',CELERIS_API_KEY:'fixture-only',
  DRY_RUN:'false',ALLOW_EXTERNAL_APPLY:'true',APPLICATION_REVIEW_MODE:'',COST_TRACKING:'false',FORM_CORPUS_DIR:join(directory,'corpus'),APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const context=await browser.newContext();let sends=0;
  await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main><h1>Fictional application</h1><label>Name<input id=name></label><button id=send onclick="window.sends=(window.sends||0)+1;document.querySelector(\'main\').innerHTML=\'Application received: ROLLBACK-FIXTURE\'">Submit application</button></main>'}):route.abort());
  const page=await context.newPage(),url='https://rollback.fixture.invalid/job';await page.goto(url);
  const calls=[...Array.from({length:6},()=>({name:'browser_action',args:{action:'script',script_intent:'inspect'}})),
   ...Array.from({length:4},()=>({name:'browser_inspect',args:{selector:'#name'}})),
   {name:'browser_snapshot',args:{}},{name:'browser_fill',args:{selector:'#name',value:'Fictional Candidate'}},
   {name:'browser_click',args:{selector:'#send',sends_application:true}},
   {name:'finish',args:{status:'applied',reason:'Fictional confirmation observed.',evidence:'Application received: ROLLBACK-FIXTURE',receipt:{quote:'Application received: ROLLBACK-FIXTURE'}}}];
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));assert.ok(body.tools.some((t:any)=>t.function.name==='browser_choose_radio'));
   const call=calls.shift();assert.ok(call,'No extra model decisions expected.');
   if(call.name==='finish')assert.equal(await page.locator('main').innerText(),'Application received: ROLLBACK-FIXTURE');
   return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}],usage:{prompt_tokens:30,completion_tokens:10}});
  }) as typeof fetch;
  const result=await runAgentOnlyApplication({page,profile:{name:'Fictional Candidate',email:'fixture@fictional.invalid',skills:[]} as never,
   job:{id:'recovery-rollback',title:'Fictional role',company:'Fictional Employer',location:'Sydney',url,platform:'indeed'},log:()=>{}});
  sends=await page.evaluate('Number(window.sends || 0)',undefined,undefined,false) as number;
  assert.equal(calls.length,0);assert.equal(result.outcome.status,'applied');assert.equal(sends,1);
  const trace=JSON.parse(readFileSync(join(directory,'traces/recovery-rollback.json'),'utf8'));
  assert.equal(trace.steps.filter((s:any)=>s.disposition==='invalid-arguments').length,6);
  assert.equal(trace.steps.filter((s:any)=>s.tool==='browser_inspect').length,4);
  assert.doesNotMatch(JSON.stringify(trace.outcome),/Recovery stalled|screenshot capture failed/);
 }finally{
  globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-recovery-rollback-'));rmSync(directory,{recursive:true,force:true});
 }
});
