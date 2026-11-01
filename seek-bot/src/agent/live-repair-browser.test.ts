import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'patchright';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';
import {createReadinessFixtureReply} from './readiness-fixture.js';
import type {AgentRunOptions} from './loop.js';

// Controlled forms and scripted model replies only. No live account or employer.
const directory=mkdtempSync(join(tmpdir(),'in-run-repair-browser-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',COST_TRACKING:'false',
  FORM_CORPUS_DIR:join(directory,'corpus'),CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',
  OWTOMATE_RUN_START_ID:'100',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
const {config}=await import('../config.js');config.dryRun=true;config.allowExternalApply=true;
const {runAgentOnlyApplication}=await import('./agent-only.js');
const {recoverDuringRun}=await import('./live-repair.js');
const {bridgeRepairRuntime}=await import('../repair-release.js');
const {traceProvesNoSend}=await import('../repair-safety.js');
const {withApplicationAllowance}=await import('../application-allowance.js');
const privacy=await import('../private-auth-fields.js');
const originalBot=resolve(import.meta.dirname,'../..'),artifact=join(directory,'release/seek-bot');
mkdirSync(artifact,{recursive:true});cpSync(join(originalBot,'dist'),join(artifact,'dist'),{recursive:true});
writeFileSync(join(artifact,'package.json'),'{"type":"module"}');
symlinkSync(join(originalBot,'node_modules'),join(artifact,'node_modules'),process.platform==='win32'?'junction':'dir');
bridgeRepairRuntime(artifact,originalBot);
const observeFile=join(artifact,'dist/agent/observe.js'),observeSource=readFileSync(observeFile,'utf8');
assert.ok(observeSource.includes('export async function observe('));
writeFileSync(observeFile,observeSource.replace('export async function observe(','async function originalObserve(')+
  '\nexport async function observe(...args) { const value=await originalObserve(...args); value.text += "\\nVALIDATED_GENERATION_FIXTURE"; return value; }\n');
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),'Fictional candidate resume');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));writeFileSync(join(directory,'answers.json'),'[]');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
const previousFetch=globalThis.fetch;
try {
 for(const prepare of [false,true]) {
  process.env.APPLICATION_REVIEW_MODE=prepare?'prepare':'';
  const context=await browser.newContext(),page=await context.newPage();
  await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:
    '<main><h1>Developer at Fixture Employer</h1><form onsubmit="event.preventDefault();window.sends++;document.querySelector(\'main\').textContent=\'Application received FIXTURE-REPAIR-1\'">'+
    '<label>Name<input id=name required oninput="window.nameWrites++"></label><label>City<input id=city required></label><button id=send>Submit application</button></form></main>'}):route.abort());
  const url=`https://employer.fixture.invalid/job/${prepare?'prepare':'auto'}`;await page.goto(url);
  privacy.rememberPrivateAuthenticationValue(page,'fixture-retained-secret');
  await page.evaluate('window.sends=0;window.nameWrites=0',undefined,undefined,false);
  let index=0,recoveryReplies=0,resumed=false,markerSeen=false,allowanceChecks=0;
  const readinessReply=createReadinessFixtureReply();
  const calls=[
   {name:'finish',args:{status:'needs-human',reason:'Malformed fixture stop',evidence:'No actual question supplied',questions:[]}},
   ...prepare?[{name:'browser_action',args:{action:'click',selector:'#send'}}]:[],
   {name:'browser_action',args:{action:'fill',selector:'#name',value:'Fixture Applicant'}},
   {name:'create_file',args:{name:'../invalid.txt',text:'Fixture',format:'txt'}},
   {name:'create_file',args:{name:'../invalid.txt',text:'Fixture',format:'txt'}},
   {name:'browser_action',args:{action:'fill',selector:'#city',value:'Sydney'}},
   prepare?{name:'prepare_application',args:{answers:[],resume_id:'cv',submit_selector:'#send'}}:
    {name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},
   {name:'finish',args:{status:'applied',reason:'Observed fixture receipt',evidence:'Application received FIXTURE-REPAIR-1',receipt:{quote:'FIXTURE-REPAIR-1'}}},
  ];
  globalThis.fetch=(async(_url,init)=>{
    const body=JSON.parse(String(init?.body)),forced=body.tool_choice?.function?.name;
    if(forced==='record_recovery_plan'||forced==='record_recovery_result'){
      const name=await page.locator('#name').inputValue(),city=await page.locator('#city').inputValue();
      const args=forced==='record_recovery_plan'?{observed_issue:'Deliberately malformed fixture calls were rejected.',evidence:['No application send was executed.'],previous_approaches:['Malformed fixture calls'],next_action:'Continue with the next supported scripted operation.',verification:'Read actual saved name and city.'}
        :{assessment:name||city?'progress':'no_progress',evidence:[`Current saved name: ${name}; city: ${city}`],next_action:'Continue the controlled fixture.'};
      return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`recovery-${++recoveryReplies}`,type:'function',function:{name:forced,arguments:JSON.stringify(args)}}]}}]});
    }
    const review=readinessReply(body);if(review)return review;
    if(resumed){assert.match(JSON.stringify(body.messages),/VALIDATED_GENERATION_FIXTURE/);markerSeen=true;}
    const call=calls[index++];assert.ok(call,'Unexpected additional model decision');
    return Response.json({usage:{prompt_tokens:1000,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`fixture-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
  }) as typeof fetch;
  const options:AgentRunOptions={simulation:'isolated-form',page,job:{id:`repair-${prepare}`,title:'Developer',company:'Fixture Employer',location:'Sydney',platform:'workday',url},
    profile:{name:'Fixture Applicant',email:'fixture@example.invalid',skills:[]} as never,log:()=>{},testRepairRequested:()=>index>=(prepare?5:4)};
  await withApplicationAllowance(()=>{allowanceChecks++;return true;},async()=>{
    const original=await runAgentOnlyApplication(options);assert.ok(original.repair,'Repeated error must hand off at a safe boundary before ending the run');
    const checkpoint=original.repair!,spent=checkpoint.meter.totals.costUsd,writes=await page.evaluate('window.nameWrites',undefined,undefined,false);
    const trace=JSON.parse(readFileSync(join(directory,'traces',`attempt-${checkpoint.attemptId}.json`),'utf8'));
    assert.equal(traceProvesNoSend(trace,'100',checkpoint.attemptId),true);
    assert.equal(trace.steps[0].execution,'not-started','an empty candidate question is rejected before a stopping decision executes');
    if(prepare){assert.equal(trace.steps[1].execution,'not-started');assert.equal(await page.evaluate('window.sends',undefined,undefined,false),0,'a rejected send intent never executes or blocks later safe recovery');}
    const result=await recoverDuringRun(options,original,{enabled:()=>true,safe:()=>true,event:()=>{},
      ticket:()=>({status:'in_run_ready',caseId:'00000000-0000-4000-8000-000000000001',runId:'100',attemptId:checkpoint.attemptId,expiresAt:Date.now()+10000}),
      load:async()=>{resumed=true;const sharedPrivacy=await import(pathToFileURL(join(artifact,'dist/private-auth-fields.js')).href);
        assert.ok((await sharedPrivacy.privateAuthenticationValues(page)).includes('fixture-retained-secret'),'private authentication redaction state must survive a generation change');
        const module=await import(pathToFileURL(join(artifact,'dist/agent/agent-only.js')).href);return module.runAgentOnlyApplication;}});
    assert.equal(markerSeen,true,'The same page must be observed through the repaired module graph');
    assert.ok(checkpoint.meter.totals.costUsd>spent,'Earlier paid usage must remain in the same meter');
    assert.equal(await page.evaluate('window.nameWrites',undefined,undefined,false),writes,'Already-completed Name is not refilled');
    assert.equal(await page.evaluate('window.sends',undefined,undefined,false),prepare?0:1);
    assert.equal(result.outcome.status,prepare?'prepared':'rehearsed');
    if(!prepare)assert.ok(allowanceChecks>0,'The original quota callback must survive the repaired graph');
    assert.equal(result.repair,undefined);
  });
  await context.close();
 }
 console.log('PASS: Auto and Semi auto resume in the same browser/run with a new tool generation; saved fields, original quota scope and spending persist. Exactly one fictional send; no real applications.');
}finally{globalThis.fetch=previousFetch;await browser.close();closeCelerisQueues();rmSync(directory,{recursive:true,force:true});}
