import { fixtureToolArguments, isSpecialistFixtureRequest } from './specialist-fixture.js';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
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
    '<label>Name<input id=name required oninput="window.nameWrites++"></label><label>Supporting attachment<input id=attachment type=file onchange="window.uploadWrites++"></label><label>City<input id=city required></label><button id=noop type=button onclick="window.noop++">Inspect details</button><button id=send>Submit application</button></form></main>'}):route.abort());
  const url=`https://employer.fixture.invalid/job/${prepare?'prepare':'auto'}`;await page.goto(url);
  privacy.rememberPrivateAuthenticationValue(page,'fixture-retained-secret');
  await page.evaluate('window.sends=0;window.nameWrites=0;window.uploadWrites=0;window.noop=0',undefined,undefined,false);
  let index=0,recoveryReplies=0,resumed=false,markerSeen=false,allowanceChecks=0,concurrencyChecked=false,recordId='',specialistCalls=0,recoveryInspection=false;
  const letter='Synthetic supporting attachment',fileId='generated:'+createHash('sha256').update(JSON.stringify(['Letter.txt','txt',letter])).digest('hex');
  const readinessReply=createReadinessFixtureReply();
  const calls=[
   {name:'finish',args:{status:'needs-human',reason:'Malformed fixture stop',evidence:'No actual question supplied',questions:[]}},
   ...prepare?[{name:'browser_action',args:{action:'click',selector:'#send'}}]:[],
   ...prepare?[{name:'browser_action',args:{action:'click',target_mode:'coordinates',selector:'#noop',x:0,y:0,sends_application:false}}]:[],
   {name:'browser_action',args:{action:'fill',target_mode:'selector',selector:'#name',ref:'f999',locator:{by:'css',value:'input',frame:'frame999'},x:0,y:0,script:'',value:'Fixture Applicant'}},
   {name:'create_file',args:{name:'Letter.txt',text:letter,format:'txt'}},
   {name:'browser_action',args:{action:'set_input_files',selector:'#attachment',file_ids:[fileId]}},
   {name:'create_file',args:{name:'../invalid.txt',text:'Fixture',format:'txt'}},
   {name:'create_file',args:{name:'../invalid.txt',text:'Fixture',format:'txt'}},
   {name:'browser_action',args:{action:'fill',selector:'#city',value:'Sydney'}},
   {name:'browser_action',args:{action:'click',target_mode:'selector',selector:'#noop',ref:'f999',locator:{by:'css',value:'input',frame:'frame999'},x:0,y:0,sends_application:false}},
   prepare?{name:'prepare_application',args:{answers:[],resume_id:'cv',supporting_file_ids:[fileId],submit_selector:'#send'}}:
    {name:'browser_action',args:{action:'click',target_mode:'selector',selector:'#send',ref:'f999',locator:{by:'css',value:'input',frame:'frame999'},x:0,y:0,sends_application:true}},
   {name:'finish',args:{status:'applied',reason:'Observed fixture receipt',evidence:'Application received FIXTURE-REPAIR-1',questions:[],receipt:{quote:'FIXTURE-REPAIR-1'}}},
  ];
  globalThis.fetch=(async(_url,init)=>{
    const body=JSON.parse(String(init?.body)),forced=body.tool_choice?.function?.name;
    if(!concurrencyChecked){concurrencyChecked=true;await assert.rejects(runAgentOnlyApplication(options),/active writer/);}
    if(isSpecialistFixtureRequest(body)) {
      specialistCalls++;
      if(resumed){assert.match(JSON.stringify(body.messages),/Letter.txt/,'specialist receives actual attachment readback retained across repair');assert.ok(JSON.stringify(body.messages).includes(recordId));}
      return Response.json({usage:{prompt_tokens:100,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`specialist-${specialistCalls}`,type:'function',function:{name:'return_application_advice',arguments:fixtureToolArguments(body,'return_application_advice',{
        advice:resumed?'Retain completed Name and attachment, then fill the remaining City field.':'Inspect the actual controlled fixture before continuing its deliberately malformed calls.',evidence:[{source:'page',detail:'Developer at Fixture Employer is the controlled visible heading.'}],unknowns:[],nextSteps:[resumed?'Fill City with Sydney and verify its actual value.':'Inspect the controlled fixture heading without changing saved fields.'],recovery_goal:resumed?{kind:'field-value',target:'City',value:'Sydney'}:{kind:'visible-text',target:'Developer at Fixture Employer',value:'Developer at Fixture Employer'},
      })}}]}}]});
    }
    if(forced==='respond_to_specialist'||forced==='check_specialist_recovery'){
      const text=body.messages.map((message:any)=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map((part:any)=>part.text??'').join('\n'):'').reverse().find((text:string)=>text.includes('RECOVERY ADVISORY\n'));
      assert.ok(text,'Specialist recovery must carry its actual shared obligation');
      const task=JSON.parse(text.match(/RECOVERY ADVISORY\n([^\n]+)/)![1]);
      const args=forced==='respond_to_specialist'?{advice_id:task.advice_id,decision:'adopt',reason:'Use the supported current fixture operation while retaining prior work.',evidence_quote:'Developer at Fixture Employer',operation_tool:'browser_action',operation_action:resumed?'fill':'inspect',operation_purpose:resumed?'Fill the remaining City field with Sydney.':'Inspect the actual controlled fixture heading.',verification:task.verification}
        :{advice_id:task.advice_id,assessment:'resolved',result_quote:task.result.slice(0,200),observation_quote:'Developer at Fixture Employer',reason:'Verified the committed operation against the actual browser and its recovery goal.'};
      if(forced==='respond_to_specialist'){
        if(resumed)assert.equal(calls[index]?.args.selector,'#city','The next normal operation must carry out the recorded repair');
        else recoveryInspection=true;
      }else if(resumed)assert.equal(await page.locator('#city').inputValue(),'Sydney','Recovery must be verified against the actual browser');
      else assert.match(await page.locator('body').innerText(),/Developer at Fixture Employer/);
      return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`specialist-recovery-${++recoveryReplies}`,type:'function',function:{name:forced,arguments:fixtureToolArguments(body,forced,args)}}]}}]});
    }
    if(forced==='browser_action'&&recoveryInspection){
      recoveryInspection=false;
      return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`specialist-inspection-${++recoveryReplies}`,type:'function',function:{name:forced,arguments:fixtureToolArguments(body,forced,{action:'inspect',selector:'body'})}}]}}]});
    }
    if(forced==='record_recovery_plan'||forced==='record_recovery_result'){
      const name=await page.locator('#name').inputValue(),city=await page.locator('#city').inputValue();
      const args=forced==='record_recovery_plan'?{observed_issue:'Deliberately malformed fixture calls were rejected.',evidence:['No application send was executed.'],previous_approaches:['Malformed fixture calls'],next_action:'Continue with the next supported scripted operation.',verification:'Read actual saved name and city.'}
        :{assessment:name||city?'progress':'no_progress',evidence:[`Current saved name: ${name}; city: ${city}`],next_action:'Continue the controlled fixture.'};
      return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`recovery-${++recoveryReplies}`,type:'function',function:{name:forced,arguments:JSON.stringify(args)}}]}}]});
    }
    const review=readinessReply(body);if(review)return review;
    if(resumed){assert.match(JSON.stringify(body.messages),/VALIDATED_GENERATION_FIXTURE/);assert.ok(JSON.stringify(body.messages).includes(recordId));assert.ok(JSON.stringify(body.messages).includes(fileId));markerSeen=true;}
    const call=calls[index++];assert.ok(call,'Unexpected additional model decision');
    return Response.json({usage:{prompt_tokens:1000,completion_tokens:10},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`fixture-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
  }) as typeof fetch;
  const options:AgentRunOptions={simulation:'isolated-form',page,job:{id:`repair-${prepare}`,title:'Developer',company:'Fixture Employer',location:'Sydney',platform:'workday',url},
    profile:{name:'Fixture Applicant',email:'fixture@example.invalid',skills:[]} as never,log:()=>{},testRepairRequested:()=>index>=(prepare?8:6)};
  await withApplicationAllowance(()=>{allowanceChecks++;return true;},async()=>{
    const original=await runAgentOnlyApplication(options);assert.ok(original.repair,'Repeated error must hand off at a safe boundary before ending the run');
    const checkpoint=original.repair!,spent=checkpoint.meter.totals.costUsd,writes=await page.evaluate('window.nameWrites',undefined,undefined,false);
    recordId=checkpoint.recoveryId;assert.ok(recordId);assert.equal('captured' in checkpoint,false,'handoff carries a shared record reference, not forked work');
    const trace=JSON.parse(readFileSync(join(directory,'traces',`attempt-${checkpoint.attemptId}.json`),'utf8'));
    assert.equal(traceProvesNoSend(trace,'100',checkpoint.attemptId),true);
    assert.equal(trace.steps[0].execution,'not-started','an empty candidate question is rejected before a stopping decision executes');
    assert.equal(await page.evaluate('window.noop',undefined,undefined,false),0,'explicit coordinate mode remains blocked in Semi auto');
    if(prepare){assert.equal(trace.steps[1].execution,'not-started');assert.equal(await page.evaluate('window.sends',undefined,undefined,false),0,'a rejected send intent never executes or blocks later safe recovery');}
    const result=await recoverDuringRun(options,original,{enabled:()=>true,safe:()=>true,event:()=>{},
      ticket:()=>({status:'in_run_ready',caseId:'00000000-0000-4000-8000-000000000001',runId:'100',attemptId:checkpoint.attemptId,expiresAt:Date.now()+10000}),
      load:async()=>{resumed=true;const sharedPrivacy=await import(pathToFileURL(join(artifact,'dist/private-auth-fields.js')).href);
        assert.ok((await sharedPrivacy.privateAuthenticationValues(page)).includes('fixture-retained-secret'),'private authentication redaction state must survive a generation change');
        const module=await import(pathToFileURL(join(artifact,'dist/agent/agent-only.js')).href);return module.runAgentOnlyApplication;}});
    assert.equal(markerSeen,true,'The same page must be observed through the repaired module graph');
    assert.ok(checkpoint.meter.totals.costUsd>spent,'Earlier paid usage must remain in the same meter');
    assert.equal(await page.evaluate('window.nameWrites',undefined,undefined,false),writes,'Already-completed Name is not refilled');
    assert.equal(await page.evaluate('window.uploadWrites',undefined,undefined,false),1,'retained attachment is not uploaded again');
    assert.equal(await page.evaluate('window.sends',undefined,undefined,false),prepare?0:1);
    assert.equal(await page.evaluate('window.noop',undefined,undefined,false),1,'explicit element mode ignores unused padded coordinates and stale iframe locators');
    assert.equal(result.outcome.status,prepare?'prepared':'rehearsed');
    if(result.outcome.status==='prepared') {
      assert.equal(result.outcome.draft.documents?.[0]?.role,'supporting');
      assert.equal(result.outcome.draft.documents?.[0]?.fileId,fileId,'retained upload must be explicitly included in the candidate review');
    }
    if(!prepare)assert.ok(allowanceChecks>0,'The original quota callback must survive the repaired graph');
    assert.equal(result.repair,undefined);
    const db=new DatabaseSync(join(directory,'application-recovery.sqlite'),{readOnly:true});
    try {
      const saved=JSON.parse(String(db.prepare('SELECT state FROM recovery_records WHERE id=?').get(recordId)!.state));
      assert.equal(saved.status,'finished');assert.ok(specialistCalls<=2);assert.equal(saved.work.files[0].id,fileId);
      assert.ok(saved.work.captured.some((answer:{question:string;answer:string})=>answer.answer==='Fixture Applicant'));
      assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_writers').get()!.n,0,'writer lease released after completion');
    } finally {db.close();}
  });
  await context.close();
 }
 console.log('PASS: Auto and Semi auto resume in the same browser/run with a new tool generation; saved fields, original quota scope and spending persist. Exactly one fictional send; no real applications.');
}finally{globalThis.fetch=previousFetch;await browser.close();closeCelerisQueues();rmSync(directory,{recursive:true,force:true});}
