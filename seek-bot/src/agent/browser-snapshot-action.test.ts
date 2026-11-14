import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'patchright';
import type {JobListing} from '../types.js';
import {validToolInput} from './tool-input.js';
import {minimaxToolSchema,minimaxToolArguments} from './provider-tool-schema.js';
import {changesBrowserState} from './browser-commands.js';
import {isSnapshotOperation} from './browser-snapshot-command.js';
import {locate} from './browser-target.js';
import {RecoveryRecord} from './recovery-record.js';
import {fixtureToolArguments} from './specialist-fixture.js';

const directory=mkdtempSync(join(tmpdir(),'snapshot-action-fixture-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',OPENROUTER_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'minimax',
 APPLICATION_REVIEW_MODE:'prepare',DRY_RUN:'false',ALLOW_EXTERNAL_APPLY:'true',COST_TRACKING:'false',AGENT_BUDGET_USD:'0.20',
 FORM_CORPUS_DIR:join(directory,'corpus'),APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Fictional snapshot fixture only.');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv-1',label:'Fixture',fileName:'CV.txt'}]));
writeFileSync(join(directory,'answers.json'),'[]');
const {agentOnlyTools}=await import('./agent-only.js');
const action=agentOnlyTools.find(t=>t.name==='browser_action')!;
assert.ok(!agentOnlyTools.some(t=>t.name==='take_snapshot'),'the duplicate standalone tool is no longer offered');
const names=agentOnlyTools.map(t=>t.name);
const expected=['test_application_helper','record_application_review','add_cover_letter','prepare_application','prepare_email_application','browser_batch','browser_action','browser_click','browser_fill','browser_upload','browser_navigate','create_file','render_approved_cover_letter','convert_file','combine_approved_documents','read_candidate_evidence','read_browser_experience','read_application_attempts','save_progress','reason_through_problem','check_employer_account','fill_authentication_fields','enter_emailed_code','open_emailed_link','record_authentication_result','wait_for_verification','investigate_application_state','wait_for_submission_result','finish'];
const inboxTools=new Set(['enter_emailed_code','open_emailed_link']);
assert.deepEqual([...names].sort(),expected.filter(name=>!inboxTools.has(name)||names.includes(name)).sort(),'all other tools remain available, subject only to the existing inbox connection');

const examples=[{action:'take_snapshot',target_mode:'page'},
 {action:'take_snapshot',target_mode:'ref',ref:'f18',screenshot:true},
 {action:'take_snapshot',target_mode:'locator',locator:{by:'css',value:'input[name="question_36[]"]'}},
 {action:'take_snapshot',selector:'section',screenshot:false}];
for(const args of examples){
 assert.equal(validToolInput(args,action.parameters),true);
 assert.equal(changesBrowserState(args),false);
 assert.equal(isSnapshotOperation('browser_action',args),true);
 const wire=minimaxToolSchema(action);assert.deepEqual(wire.parameters.required,['action']);
 assert.deepEqual(minimaxToolArguments(action,args),args);
}
for(const extra of [{sends_application:true},{sends_application:false},{replaces_file_ids:['fixture']},{value:'unsafe'},{script:'document.body.remove()'},
 {file_ids:['fixture']},{wait:{url:'https://other.invalid'}},{page_index:2},{x:10,y:10},{unexpected:true},{screenshot:'yes'}]){
 assert.equal(validToolInput({action:'take_snapshot',...extra},action.parameters),false,JSON.stringify(extra));
}
for(const screenshot of [true,false,null])assert.equal(validToolInput({action:'fill',selector:'input',value:'fixture',screenshot},action.parameters),false,
 'declaring screenshot for snapshot must not silently allow it on writes');
assert.equal(isSnapshotOperation('take_snapshot',{}),true);
assert.equal(isSnapshotOperation('browser_action',{action:'inspect'}),false);

let turn=0,captures=0,lastCaptureCount=0;
const operations:Array<{tool:string;action?:string;mutating:boolean}>=[];
const begin=RecoveryRecord.prototype.begin;
RecoveryRecord.prototype.begin=function(tool,action,mutating){operations.push({tool,action,mutating});return begin.call(this,tool,action,mutating)};
let page:Awaited<ReturnType<import('patchright').BrowserContext['newPage']>>;
const refFrom=(text:string)=>text.match(/button "Read-only marker" \[ref=([^\]]+)\]/)?.[1];
globalThis.fetch=(async(_url,init)=>{
 const body=JSON.parse(String(init?.body));
 assert.ok(!body.tools.some((t:any)=>t.function.name==='take_snapshot'),'provider only sees one snapshot operation');
 let call:{name:string;args:Record<string,unknown>};
 const last=body.messages.filter((m:{role:string})=>m.role==='tool').at(-1)?.content;
 const latest=body.messages.filter((m:{role:string})=>m.role==='user').at(-1)?.content;
 if(turn){
  assert.equal(captures-lastCaptureCount,1,'each action must execute exactly one canonical accessibility capture');
  assert.doesNotMatch(String(last),/snapshot-private-fixture|Browser\/tool error/);
  const ref=refFrom(String(last));assert.ok(ref,'snapshot returns a usable accessibility reference');
  assert.equal(await locate(page,ref)!.count(),1,'returned refs still resolve to the freshly captured page');
 }
 lastCaptureCount=captures;
 if(turn===0){
  const offered=body.tools.find((t:any)=>t.function.name==='browser_action');
  assert.match(offered.function.description,/take_snapshot/);
  assert.doesNotMatch(offered.function.description,/action=script needs/, 'MiniMax must not be instructed to invoke unavailable script actions');
  const batch=body.tools.find((t:any)=>t.function.name==='browser_batch');
  assert.match(batch.function.description,/Native actions only; scripts are unavailable/);
  assert.doesNotMatch(batch.function.description,/browser scripts and/);
  call={name:'browser_action',args:{action:'take_snapshot',target_mode:'page',screenshot:true}};
 }else if(turn===1){
  assert.ok(Array.isArray(latest)&&latest.some((p:any)=>p.type==='image_url'),'snapshot screenshot request reaches the next privacy-masked observation');
  call={name:'browser_action',args:{action:'take_snapshot',target_mode:'locator',locator:{by:'css',value:'section'}}};
 }else if(turn===2){
  assert.match(String(last),/Matched 2 snapshot targets/);
  call={name:'browser_action',args:{action:'take_snapshot',target_mode:'locator',locator:{by:'css',value:'#first'}}};
 }else if(turn===3){
  call={name:'browser_action',args:{action:'take_snapshot',target_mode:'ref',ref:refFrom(String(last))!}};
 }else if(turn===4){
  call={name:'finish',args:{status:'already-applied',reason:'The fictional fixture confirms prior application.',evidence:'The page and its address indicate the application is already on file.'}};
 }else throw Error('Unexpected model request; fixture has no paid fallback');
 const index=turn++;
 return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`snapshot-${index}`,type:'function',function:{name:call.name,arguments:fixtureToolArguments(body,call.name,call.args)}}]}}],usage:{prompt_tokens:30,completion_tokens:10}});
}) as typeof fetch;
const {runApplicationAgent}=await import('./loop.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
let restoreLocator: (()=>void)|undefined;
try{
 const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')
  ?route.fulfill({contentType:'text/html',body:'<main>Fixture</main>'}):route.abort());
 page=await context.newPage();const url='https://snapshot.fixture.invalid/apply';await page.goto(url);
 await page.setContent('<main><p>You already applied to this position.</p><section id="first"><h2>Snapshot fixture</h2><label>Name<input value="Saved fictional answer" oninput="window.writes=(window.writes||0)+1"></label><button type="button" onclick="window.writes=(window.writes||0)+1">Read-only marker</button></section><section><label>Password<input type="password" value="snapshot-private-fixture"></label></section></main>');
 const aria=page.ariaSnapshot.bind(page);page.ariaSnapshot=(async(...args:Parameters<typeof page.ariaSnapshot>)=>{captures++;return aria(...args)}) as typeof page.ariaSnapshot;
 const prototype=Object.getPrototypeOf(page.locator('#first')),locatorSnapshot=prototype.ariaSnapshot;
 prototype.ariaSnapshot=async function(...args:any[]){captures++;return locatorSnapshot.apply(this,args)};
 restoreLocator=()=>{prototype.ariaSnapshot=locatorSnapshot};
 const result=await runApplicationAgent({page,job:{id:'snapshot-readonly-fixture',title:'Fictional role',company:'Fixture',location:'Sydney',url,applicationMode:'external'} as JobListing,
  profile:{name:'Alex Fixture',email:'fixture@fixture.invalid',skills:[],willingToRelocate:false} as never,log:()=>{}});
 assert.equal(turn,5);assert.equal(captures,4);assert.equal(result.outcome.status,'already-applied');assert.equal(result.submitPressed,false);
 assert.equal(await page.locator('input[type=password]').inputValue(),'snapshot-private-fixture','privacy masking restores the original private field');
 assert.equal(await page.locator('input').first().inputValue(),'Saved fictional answer');
 assert.equal(await page.evaluate('window.writes||0',undefined,undefined,false),0,'reads cannot emit input/click events or submit');
 const reads=operations.filter(o=>isSnapshotOperation(o.tool,{action:o.action}));assert.equal(reads.length,4);assert.ok(reads.every(o=>!o.mutating),'same read-only recovery classification');
 const trace=JSON.parse(readFileSync(join(directory,'traces/snapshot-readonly-fixture.json'),'utf8'));
 assert.equal(trace.steps.filter((s:any)=>isSnapshotOperation(s.tool,s.args)).length,4);assert.ok(trace.steps.every((s:any)=>s.disposition!=='invalid-arguments'));
 assert.doesNotMatch(JSON.stringify(trace),/snapshot-private-fixture/);
 console.log('PASS: declared MiniMax snapshot compatibility, closed arguments, one canonical capture per operation, usable refs, masked screenshot/privacy and read-only recovery; no real applicant or paid call.');
}finally{
 restoreLocator?.();RecoveryRecord.prototype.begin=begin;await browser.close();
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});
}
