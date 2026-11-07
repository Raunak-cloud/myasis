import { isSpecialistFixtureRequest } from './specialist-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'patchright';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';
import { withApplicationModel } from '../application-model.js';
import { RecoveryRecord } from './recovery-record.js';
import { investigateApplicationState } from './investigation.js';
import { doCompleteAuthentication,doRecordAuthenticationResult } from './authentication.js';
import { pendingCredential,storedCredential,stagePendingCredential,acceptPendingCredential,rejectCredential } from '../site-credentials.js';
import { observe } from './observe.js';
import { createReadinessFixtureReply } from './readiness-fixture.js';
import type { ToolContext } from './context.js';

const dir=mkdtempSync(join(tmpdir(),'uncertainty-browser-'));
Object.assign(process.env,{DATA_DIR:dir,CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',COST_TRACKING:'false',
  CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',SITE_AUTH_SECRET:'uncertainty-fixture-only',
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false',OWTOMATE_RUN_START_ID:'999'});
const {config}=await import('../config.js');config.dryRun=true;config.allowExternalApply=true;
const {runAgentOnlyApplication}=await import('./agent-only.js');
mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes/CV.txt'),'Fixture candidate CV');
writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));writeFileSync(join(dir,'answers.json'),'[]');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
const originalFetch=globalThis.fetch;
try {
  const context=await browser.newContext(),page=await context.newPage();
  await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:'<main>Fixture</main>'}):route.abort());
  await page.goto('https://ats.fixture.invalid/reset');
  const owner=join(dir,'auth-owner');mkdirSync(owner);
  await withApplicationModel({DATA_DIR:owner},async()=>{
    const record=new RecoveryRecord(owner,'main',{runId:'999',jobId:'reset-fixture',platform:'workday',mode:'prepare',contextHash:'candidate'},'auth');
    const ctx={page,recoveryRecord:record,profile:{name:'Fixture Candidate',email:'candidate@fixture.invalid',phone:'0400000000'},job:{id:'reset-fixture',title:'Developer',company:'Fixture Employer'},captured:[],actions:[],log:()=>{}} as unknown as ToolContext;
    const login='<main><h1>Sign in to your candidate account</h1><label>Email<input id=email type=email></label><label>Password<input id=password type=password></label></main>';
    try {
      // Recovery is authorized for an account Owtomate previously managed,
      // rather than an unknown pre-existing account belonging to the candidate.
      stagePendingCredential(page.url(),ctx.profile.email,ctx.job.company,'create_account',{format:'readable-v1'});
      assert.equal(acceptPendingCredential(page.url(),ctx.profile.email,ctx.job.company,'create_account'),true);
      rejectCredential(page.url(),ctx.profile.email,ctx.job.company);
      await page.setContent('<main><h1>Choose a new password</h1><label>New password<input id=password type=password></label></main>');ctx.observation=await observe(page);
      await doCompleteAuthentication(ctx,{purpose:'reset_password',targets:[{selector:'#password'}],password_rules:{max_length:18}});
      const chosen=await page.locator('#password').inputValue();assert.ok(chosen);
      await page.setContent(login);ctx.observation=await observe(page);
      const unknown=await doRecordAuthenticationResult(ctx,{purpose:'reset_password',outcome:'accepted',evidence:'The reset redirected to login.'});
      assert.equal(unknown.kind==='ok'&&unknown.disposition,'uncertain');assert.equal(storedCredential(page.url(),ctx.profile.email),null);
      assert.ok(pendingCredential(page.url(),ctx.profile.email,ctx.job.company,'reset_password'));
      const first=await investigateApplicationState(ctx,{check:'form',question:'Was the reset accepted?'},()=> 'No receipt found.');
      assert.match(first.kind==='ok'?first.message:'',/Sign in to your candidate account/);
      const again=await investigateApplicationState(ctx,{check:'form',question:'Please check it again with a different question.'},()=> 'No receipt found.');
      assert.match(again.kind==='ok'?again.message:'',/UNCHANGED INVESTIGATION CHECK/);
      assert.equal(record.snapshot().investigations?.[0].checks.length,1,'wording changes cannot mint another read');
      assert.equal(record.snapshot().investigations?.[0].status,'investigating');
      assert.ok(!ctx.actions.some(action=>['password-reset','authentication-rejected','signed-in'].includes(action.kind)));
      const blocked=await doCompleteAuthentication(ctx,{purpose:'sign_in',targets:[{selector:'#email'},{selector:'#password'}]});
      assert.equal(blocked.kind==='ok'&&blocked.disposition,'uncertain');assert.equal(await page.locator('#password').inputValue(),'');
      // A delayed employer result arrives after the redirect. The safe check
      // finds it; only the existing exact-message verifier accepts the reset.
      await page.setContent(login.replace('<h1>','<p>Your password has been updated.</p><h1>'));ctx.observation=await observe(page);
      await investigateApplicationState(ctx,{check:'form',question:'Did fresh employer evidence arrive?'},()=> 'No receipt found.');
      await doRecordAuthenticationResult(ctx,{purpose:'reset_password',outcome:'accepted',evidence:'Your password has been updated.'});
      assert.ok(storedCredential(page.url(),ctx.profile.email));assert.equal(record.snapshot().investigations?.[0].status,'resolved');
      await doCompleteAuthentication(ctx,{purpose:'sign_in',targets:[{selector:'#email'},{selector:'#password'}]});
      assert.equal(await page.locator('#password').inputValue(),chosen,'the accepted original proposal is reused exactly');
    } finally {record.release();}
  });
  await page.goto('https://employer.fixture.invalid/apply');
  await page.setContent('<main><h1>Developer at Fixture Employer</h1><label>City<input id=city required></label><button id=send onclick="window.sends++;document.querySelector(\'main\').textContent=\'Application received INVESTIGATION-1\'">Submit application</button></main>');
  await page.evaluate('window.writes=0;window.sends=0',undefined,undefined,false);
  let index=0;const review=createReadinessFixtureReply();
  const calls=[
    {name:'browser_action',args:{action:'script',script:"document.querySelector('#city').value='Sydney';window.writes++;throw new Error('Timeout after a successful write')",sends_application:false}},
    {name:'investigate_application_state',args:{check:'control',selector:'#city',question:'Did the write succeed before the error?'}},
    {name:'browser_action',args:{action:'click',selector:'#send',sends_application:true}},
    {name:'finish',args:{status:'applied',reason:'Observed employer receipt',evidence:'Application received INVESTIGATION-1',receipt:{quote:'Application received INVESTIGATION-1'}}},
  ];
  globalThis.fetch=(async(_url,init)=>{
    const body=JSON.parse(String(init?.body)),ready=review(body);if(ready)return ready;
    if(index===2)assert.match(JSON.stringify(body.messages),/INVESTIGATION EVIDENCE.*Sydney/s,'the parent must see actual saved work before continuing');
    const call=calls[index++];assert.ok(call,'No redundant report or extra decision is needed');
    return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'fixture-'+index,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}],usage:{prompt_tokens:100,completion_tokens:10}});
  }) as typeof fetch;
  const job={id:'uncertain-write',title:'Developer',company:'Fixture Employer',location:'Sydney',url:page.url(),platform:'workday' as const};
  const result=await runAgentOnlyApplication({simulation:'isolated-form',page,job,profile:{name:'Fixture Candidate',email:'candidate@fixture.invalid',skills:[]} as never,log:()=>{}});
  assert.equal(result.outcome.status,'rehearsed');assert.equal(index,4);
  assert.equal(await page.evaluate('window.writes',undefined,undefined,false),1,'an uncertain write is investigated, not replayed');
  assert.equal(await page.evaluate('window.sends',undefined,undefined,false),1,'exactly one fictional send');
  // An explicitly unknown authentication outcome gets one automatic safe form
  // check before a technical stop, without manufacturing success or a question.
  await page.setContent('<main><h1>Candidate access is still being checked</h1></main>');index=0;
  const stopCalls=[{name:'record_authentication_result',args:{purpose:'reset_password',outcome:'uncertain',evidence:'No employer verdict yet.'}},
    ...Array.from({length:2},()=>({name:'finish',args:{status:'skipped',reason:'Reset outcome is still uncertain after safe checks.',evidence:'Candidate access is still being checked'}}))];
  globalThis.fetch=(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(isSpecialistFixtureRequest(body))return Response.json({choices:[{message:{content:JSON.stringify({advice:'The outcome remains unknown; preserve it honestly without another reset.',evidence:[{source:'page',detail:'Candidate access is still being checked'}],unknowns:['Reset acceptance'],nextSteps:['Report unresolved access honestly.']})}}]});
    const call=stopCalls[index++];assert.ok(call,'Investigation cannot loop indefinitely');
    return Response.json({choices:[{message:{tool_calls:[{id:'stop-'+index,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
  }) as typeof fetch;
  const stopped=await runAgentOnlyApplication({simulation:'isolated-form',page,job:{...job,id:'uncertain-stop'},profile:{name:'Fixture Candidate',email:'candidate@fixture.invalid',skills:[]} as never,log:()=>{}});
  assert.equal(stopped.outcome.status,'rehearsed');assert.match(stopped.outcome.status==='rehearsed'?stopped.outcome.stoppedAt:'',/skipped/);assert.equal(index,3);
  const db=new DatabaseSync(join(dir,'application-recovery.sqlite'),{readOnly:true});
  try {
    const saved=db.prepare('SELECT state FROM recovery_records').all().map(row=>JSON.parse(String(row.state))).find(state=>state.scope.jobId==='uncertain-stop');
    assert.equal(saved.investigations[0].status,'unresolved');assert.equal(saved.investigations[0].checks.length,1);
    assert.equal(saved.work.actions.some((action:{kind:string})=>['password-reset','authentication-rejected','signed-in'].includes(action.kind)),false);
  } finally {db.close();}
  await context.close();
  console.log('PASS: missing reset message stays unknown, safe reads discover delayed evidence, unchanged checks are reused, a write-before-error is not repeated, one fictional send and one bounded stopping investigation. No real applications or provider calls.');
} finally {globalThis.fetch=originalFetch;await browser.close();closeCelerisQueues();rmSync(dir,{recursive:true,force:true});}
