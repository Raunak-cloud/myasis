import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'patchright';
import {browserDeadline,browserOperationOptions} from '../browser-deadline.js';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

test('native cancellation prevents a queued click after control returns to the caller', {timeout:10000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try {
  const page=await browser.newPage();
  await page.setContent('<main>Waiting for the delayed control</main>');
  const controller=new AbortController(),cause=new Error('Fixture owner stopped');
  let nativeResult!:Promise<{ok:boolean;error?:unknown}>;
  const running=browserDeadline('Queued click',2000,()=>{
   const native=page.locator('#later').click(browserOperationOptions());
   nativeResult=native.then(()=>({ok:true}),error=>({ok:false,error}));
   return native;
  },controller.signal);
  const runningResult=running.then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));
  await delay(50);controller.abort(cause);
  const cancelled=await runningResult;
  assert.equal(cancelled.ok,false);assert.equal(cancelled.error,cause);
  await page.evaluate(()=>{const button=document.createElement('button');button.id='later';button.textContent='Later';button.onclick=()=>{document.body.dataset.clicks='1';};document.body.append(button);});
  assert.equal((await nativeResult).ok,false);await delay(150);
  assert.equal(await page.locator('body').getAttribute('data-clicks'),null);
 } finally {await browser.close();}
});

test('real agent tools wait for late controls and give each healthy batch step its own allowance', {timeout:90000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'owtomate-browser-budget-'));
 const environment={...process.env},fetchBefore=globalThis.fetch;
 Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',APPLICATION_AI_MODEL:'celeris',DRY_RUN:'false',ALLOW_EXTERNAL_APPLY:'true',APPLICATION_REVIEW_MODE:'',COST_TRACKING:'false',FORM_CORPUS_DIR:join(directory,'corpus'),APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
 mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Alex Fixture. Fictional candidate.');
 writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try {
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main>Isolated timing fixture</main>'}):route.abort());
  const page=await context.newPage(),url='https://timing.fixture.invalid/apply';await page.goto(url);
  const profile={name:'Alex Fixture',email:'alex@fixture.invalid',skills:[]} as never;
  let calls:Array<{name:string;args:Record<string,unknown>}> = [];
  globalThis.fetch=(async(_input,init)=>{
   const body=JSON.parse(String(init?.body));assert.ok(body.tools?.length,'No live provider calls or separate reviewers');
   const call=calls.shift();assert.ok(call,'Unexpected extra model turn');
   return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}],usage:{prompt_tokens:50,completion_tokens:10}});
  }) as typeof fetch;
  const finish={name:'finish',args:{status:'skipped',reason:'Isolated timing checks complete.',evidence:'Fixture state checked directly.'}};
  await page.setContent('<main><h1>Fictional application</h1><script>setTimeout(()=>{const b=document.createElement("button");b.id="late";b.textContent="Continue";b.onclick=()=>{document.body.dataset.lateClicks=String(Number(document.body.dataset.lateClicks||0)+1)};document.body.append(b)},3500)</script></main>');
  calls=[{name:'browser_action',args:{action:'click',selector:'#late',sends_application:false}},finish];
  const late=await runAgentOnlyApplication({page,profile,job:{id:'late-control',title:'Fixture Analyst',company:'Fictional Employer',location:'Sydney',url,platform:'indeed'},log:()=>{}});
  assert.equal(late.outcome.status,'skipped');assert.equal(calls.length,0);
  assert.equal(await page.locator('body').getAttribute('data-late-clicks'),'1','A control appearing after the old 2.5-second probe is clicked once');
  await page.setContent(`<main><h1>Long healthy form batch</h1><script>setTimeout(()=>{const input=document.createElement('input');input.id='first';input.oninput=()=>{document.body.dataset.firstEvents=String(Number(document.body.dataset.firstEvents||0)+1);setTimeout(()=>{if(document.querySelector('#second'))return;const second=document.createElement('input');second.id='second';second.oninput=()=>{document.body.dataset.secondEvents=String(Number(document.body.dataset.secondEvents||0)+1)};document.body.append(second)},16000)};document.body.append(input)},16000)</script></main>`);
  calls=[{name:'browser_batch',args:{actions:[{action:'fill',selector:'#first',value:'first value'},{action:'fill',selector:'#second',value:'second value'}]}},finish];
  const started=Date.now();
  const batch=await runAgentOnlyApplication({page,profile,job:{id:'healthy-long-batch',title:'Fixture Analyst',company:'Fictional Employer',location:'Sydney',url,platform:'indeed'},log:()=>{}});
  assert.equal(batch.outcome.status,'skipped');assert.equal(calls.length,0);
  assert.ok(Date.now()-started>30000,'The complete batch exceeds the former shared deadline');
  assert.equal(await page.locator('#first').inputValue(),'first value');assert.equal(await page.locator('#second').inputValue(),'second value');
  assert.equal(await page.locator('body').getAttribute('data-first-events'),'1','Earlier successful work is never replayed');
  assert.equal(await page.locator('body').getAttribute('data-second-events'),'1');
 } finally {
  globalThis.fetch=fetchBefore;await browser.close();closeCelerisQueues();
  for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-browser-budget-'));rmSync(directory,{recursive:true,force:true});
 }
});
