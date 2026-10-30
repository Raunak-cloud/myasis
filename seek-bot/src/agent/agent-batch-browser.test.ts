import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import type {JobListing} from '../types.js';
const directory=mkdtempSync(join(tmpdir(),'agent-batch-browser-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',DRY_RUN:'false',ALLOW_EXTERNAL_APPLY:'true',AGENT_BUDGET_USD:'0.20',FORM_CORPUS_DIR:join(directory,'corpus'),APPLICATION_REVIEW_MODE:'',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Fictional candidate');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv-1',label:'Fixture',fileName:'CV.txt'}]));writeFileSync(join(directory,'answers.json'),'[]');
let turn=0;
globalThis.fetch=(async(_url,init)=>{
 const body=JSON.parse(String(init?.body));let calls;
 const latest=()=>body.messages.filter((m:{role:string})=>m.role==='tool').at(-1).content;
 if(turn===0){
  assert.equal(body.tools.some((t:{function:{name:string}})=>t.function.name==='prepare_application'),false,'Auto apply cannot choose an unavailable Semi auto preparation tool');
  assert.ok(body.tools.some((t:{function:{name:string}})=>t.function.name==='prepare_email_application'),'email still requires explicit candidate confirmation');
  const batch=body.tools.find((t:{function:{name:string}})=>t.function.name==='browser_batch');
  assert.ok(batch.function.parameters.properties.actions.items.properties.action.enum.includes('inspect'));
  calls=[{name:'browser_batch',args:{actions:[{action:'fill',selector:'#name',value:'Alex Fixture'},{action:'inspect',selector:'input'}]}}];
 }else if(turn===1){
  const batch=JSON.parse(latest());assert.equal(batch.completed,2);
  const inspected=JSON.parse(batch.results[1].message);assert.equal(inspected.matched,3);
  assert.equal(inspected.fields[0].value,'Alex Fixture');assert.equal(inspected.fields[2].value,'[private credential]');
  assert.doesNotMatch(latest(),/private-batch-fixture/);
  calls=[{name:'browser_batch',args:{actions:[{action:'fill',selector:'input',value:'Wrong target'},{action:'fill',selector:'#other',value:'Should not run'}]}}];
 }else if(turn===2){
  const batch=JSON.parse(latest());assert.equal(batch.stopped,0);assert.equal(batch.remainingNotExecuted,true);assert.match(batch.results[0].error,/strict mode violation/);
  calls=[{name:'browser_action',args:{action:'type',selector:'#keys',value:'Sydney'}}];
 }else if(turn===3){
  const readback=JSON.parse(latest());assert.equal(readback.current.value,'Sydney');
  calls=[{name:'browser_batch',args:{actions:Array.from({length:15},()=>({action:'click',selector:'#year'}))}}];
 }else if(turn===4){
  const batch=JSON.parse(latest());assert.equal(batch.completed,15);
  calls=[{name:'finish',args:{status:'needs-human',reason:'Fixture checks complete: ambiguous write was refused.',evidence:'Inspection succeeded; ambiguous fill executed nowhere.',questions:[{question:'Fixture target',prompt:'Choose the intended control.',kind:'text'}]}}];
 }else throw Error('Unexpected model call');
 return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:calls.map((call,index)=>({id:`batch-${turn++}-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))}}],usage:{prompt_tokens:30,completion_tokens:10}});
}) as typeof fetch;
const {runApplicationAgent}=await import('./loop.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
try{
 const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main>Fixture</main>'}):route.abort());
 const page=await context.newPage(),url='https://employer.batch.invalid/apply';await page.goto(url);
 await page.setContent('<main><label>Name<input id=name oninput="window.inputEvents=(window.inputEvents||0)+1"></label><label>Other<input id=other value=Untouched></label><label>Password<input type=password value=private-batch-fixture></label><div id=keys contenteditable onkeyup="window.keyEvents=(window.keyEvents||0)+1;this.dataset.committed=this.textContent"></div><button id=year type=button onclick="window.yearClicks=(window.yearClicks||0)+1">Previous year</button></main>');
 const result=await runApplicationAgent({page,job:{id:'batch-fixture',title:'Fixture',company:'Fictional employer',location:'Sydney',url,applicationMode:'external'} as JobListing,profile:{name:'Alex Fixture',email:'fixture@example.invalid',skills:['TypeScript'],willingToRelocate:false} as never,log:()=>{}});
 assert.equal(result.outcome.status,'needs-human');assert.equal(turn,5);
 assert.equal(await page.evaluate('window.yearClicks',undefined,undefined,false),15,'longer calendar batches execute every action');
 assert.equal(await page.locator('#name').inputValue(),'Alex Fixture');assert.equal(await page.locator('#other').inputValue(),'Untouched');
 assert.equal(await page.evaluate('window.inputEvents',undefined,undefined,false),1,'normal input event fired exactly once');
 assert.equal(await page.locator('#keys').getAttribute('data-committed'),'Sydney');
 assert.equal(await page.evaluate('window.keyEvents',undefined,undefined,false),6,'native typing fires real key events for each character');
 console.log('PASS: mixed native fill/inspection batch, private-value masking, strict ambiguous writes and stop-on-error.');
}finally{await browser.close();rmSync(directory,{recursive:true,force:true});}
