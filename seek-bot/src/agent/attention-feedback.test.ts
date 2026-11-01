import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';
import {createReadinessFixtureReply} from './readiness-fixture.js';
const directory=mkdtempSync(join(tmpdir(),'attention-feedback-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',APPLICATION_REVIEW_MODE:'prepare',
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',COST_TRACKING:'false'});
const {config}=await import('../config.js');config.dryRun=true;config.allowExternalApply=true;
const {runAgentOnlyApplication}=await import('./agent-only.js');
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Fictional resume');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
const originalFetch=globalThis.fetch;
try{
 const context=await browser.newContext(),page=await context.newPage(),url='https://attention.fixture.invalid/application';
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='attention.fixture.invalid'?route.fulfill({contentType:'text/html',body:
  '<main><h1>Fixture Developer application</h1><form><label>Suburb<input id=suburb required></label><button id=send>Submit application</button></form></main>'}):route.abort());
 await page.goto(url);
 let i=0;const readiness=createReadinessFixtureReply();
 const calls=[
  {name:'finish',args:{status:'needs-human',reason:'The required field is not filled yet.',evidence:'Suburb is blank.',questions:[],answers:[{question:'Suburb',answer:'Invented completion'}]}},
  {name:'browser_action',args:{action:'fill',selector:'#suburb',value:'Sydney'}},
  {name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}},
 ];
 globalThis.fetch=(async(_url,init)=>{
  const body=JSON.parse(String(init?.body)),review=readiness(body);if(review)return review;
  if(i===1){const prior=body.messages.filter((m:any)=>m.role==='tool').at(-1)?.content;
    assert.match(prior,/requires at least one actual observed employer question/);assert.equal(await page.locator('#suburb').inputValue(),'');}
  const call=calls[i++];assert.ok(call,'Known answers must complete after a grounded correction, without a false attention item');
  return Response.json({usage:{prompt_tokens:100,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'c'+i,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
 }) as typeof fetch;
 const result=await runAgentOnlyApplication({simulation:'isolated-form',page,job:{id:'attention-feedback',title:'Developer',company:'Fixture',location:'Sydney',platform:'workday',url},
  profile:{name:'Fixture',email:'fixture@example.invalid',suburb:'Sydney',skills:[]} as never,log:()=>{}});
 assert.equal(result.outcome.status,'prepared');assert.equal(result.submitPressed,false);assert.equal(await page.locator('#suburb').inputValue(),'Sydney');
 assert.ok(result.captured.every(answer=>answer.answer!=='Invented completion'));
 const trace=JSON.parse(readFileSync(join(directory,'traces','attention-feedback.json'),'utf8'));
 assert.equal(trace.steps[0].disposition,'invalid-arguments');
 console.log('PASS: empty Needs attention receives actionable feedback; known answers are completed and prepared without false questions or invented completion.');
}finally{globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();rmSync(directory,{recursive:true,force:true});}
