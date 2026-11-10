import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {specialistFixtureReply} from './specialist-fixture.js';
import type {ToolContext} from './context.js';
const directory=mkdtempSync(join(tmpdir(),'employer-account-first-'));
Object.assign(process.env,{DATA_DIR:directory,SITE_AUTH_SECRET:'fictional-employer-account-secret',CELERIS_API_KEY:'fixture-only',APPLICATION_AI_MODEL:'celeris',DRY_RUN:'true',ALLOW_EXTERNAL_APPLY:'true',COST_TRACKING:'false',FORM_CORPUS_DIR:join(directory,'corpus'),APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'false'});
const {doCompleteAuthentication,doCheckEmployerAccount,doRecordAuthenticationResult,authenticationAccountSummary}=await import('./authentication.js');
const {stagePendingCredential,acceptPendingCredential,storedCredential,rejectCredential,pendingCredential,employerCredentialState}=await import('../site-credentials.js');
const {employerAccountSite}=await import('../employer-account.js');
const {sitePassword}=await import('../site-auth.js');
const {observe}=await import('./observe.js');
const {runAgentOnlyApplication}=await import('./agent-only.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
const previousFetch=globalThis.fetch;
try{
 const email='candidate@fixture.invalid',company='Fixture Employer';
 for(const board of ['https://www.seek.com.au/login','https://au.indeed.com/login'])assert.equal(employerAccountSite(board,'First Employer'),employerAccountSite(board,'Another Employer'),'a job-board login belongs to the board, not each vacancy employer');
 const html='<main><h1>Employer account</h1><p>An account already exists with this email. Please sign in.</p><label>Email<input type=email id=email oninput="window.writes++"></label><label>Password<input type=password id=password oninput="window.writes++"></label></main>';
 const context=await browser.newContext();
 await context.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:html}):route.abort());
 const page=await context.newPage();await page.goto('https://account.fixture.invalid/login');await page.evaluate(()=>{(window as any).writes=0;});
 const ctx=async(employer=company)=>({page,job:{id:'fictional',title:'Synthetic analyst',company:employer,url:page.url(),location:'Sydney',platform:'workday'},profile:{name:'Fixture Candidate',email,phone:'0400000000',skills:[]},observation:await observe(page,{screenshot:false}),actions:[],captured:[],log:()=>{}} as unknown as ToolContext);
 const fields={targets:[{selector:'#email'},{selector:'#password'}]};
 let state=await ctx();
 const lookup=await doCheckEmployerAccount(state,{});assert.equal(lookup.kind,'ok');assert.equal(await page.evaluate(()=>(window as any).writes),0,'first lookup cannot write any field');
 await doCompleteAuthentication(state,{purpose:'reset_password',...fields});assert.equal(await page.locator('#password').inputValue(),'','unknown existing accounts cannot start password replacement');
 await doCompleteAuthentication(state,{purpose:'create_account',...fields});
 assert.equal(pendingCredential(page.url(),email,company,'create_account')?.phase,'prepared');
 const handoff=await doCheckEmployerAccount(state,{outcome:'existing',evidence:'An account already exists with this email. Please sign in.'});
 assert.equal(handoff.kind,'terminal');
 if(handoff.kind==='terminal'){
  assert.equal(handoff.outcome.status,'skipped');
  assert.match(handoff.outcome.reason ?? '',/no verified login/);
 }
 assert.equal(pendingCredential(page.url(),email,company,'create_account'),null,'a rejected duplicate draft is not a managed account');
 assert.equal(await page.locator('#password').inputValue(),'','a rejected registration proposal is retired from the actual form before the user handoff');
 assert.equal(state.pendingCredentials?.size,0);
 state=await ctx();
 assert.equal((await doCompleteAuthentication(state,{purpose:'sign_in',...fields})).kind,'terminal','existing-account handoff survives a fresh applying context');
 assert.equal(await page.locator('#password').inputValue(),'');
 assert.equal(employerCredentialState(page.url(),'another@fixture.invalid',company).state,'missing');
 globalThis.fetch=async()=>{throw Error('Saved external-account access must stop before a model request.');};
 const waiting=await runAgentOnlyApplication({simulation:'isolated-form',page,job:state.job,profile:state.profile,log:()=>{}});
 assert.equal(waiting.outcome.status,'skipped','the actual applying loop skips the saved external account before any further model/action');
 state.submissionAttempted=true;
 assert.equal((await doCheckEmployerAccount(state,{})).kind,'ok','an uncertain application send cannot turn into a retryable access task');

 // An actual new account retains the same password through interruption and activation.
 await page.goto('https://new-account.fixture.invalid/register');state=await ctx();
 await doCompleteAuthentication(state,{purpose:'create_account',...fields});
 const original=await page.locator('#password').inputValue();assert.ok(original);
 await page.setContent('<main><p>Check your email to activate your account.</p></main>');
 await doRecordAuthenticationResult(state,{purpose:'create_account',outcome:'needs_verification',evidence:'Check your email to activate your account.'});
 assert.equal(employerCredentialState(page.url(),email,company).state,'pending');assert.equal(storedCredential(page.url(),email,company),null);
 await page.setContent('<main><p>Your account is now active.</p></main>');state=await ctx();
 await doRecordAuthenticationResult(state,{purpose:'create_account',outcome:'accepted',evidence:'Your account is now active.'});
 await page.setContent(html);state=await ctx();
 const duplicate=await doCompleteAuthentication(state,{purpose:'create_account',...fields});assert.equal(duplicate.kind==='ok'&&duplicate.disposition,'reobserve');assert.equal(await page.locator('#password').inputValue(),'');
 await doCompleteAuthentication(state,{purpose:'sign_in',...fields});assert.equal(await page.locator('#password').inputValue(),original,'future sign-in reuses the exact accepted private credential');
 assert.ok(!JSON.stringify(state.actions).includes(original));

 // Independent tenants, one ATS host; redirect recovery cannot reject the neighbour.
 const first='https://career10.successfactors.com/career?company=TenantA',second='https://career10.successfactors.com/career?company=TenantB';
 for(const [url,employer] of [[first,'First Employer'],[second,'Second Employer']]){
  const credential={format:'readable-v1' as const,derivationScope:employerAccountSite(url,employer)};
  stagePendingCredential(url,email,employer,'create_account',credential);assert.equal(acceptPendingCredential(url,email,employer,'create_account'),true);
 }
 const a=storedCredential(first,email,'First Employer'),b=storedCredential(second,email,'Second Employer');assert.ok(a&&b);
 assert.notEqual(sitePassword(first,email,undefined,a),sitePassword(second,email,undefined,b));
 rejectCredential('https://career10.successfactors.com/career',email,'First Employer');
 assert.equal(storedCredential(first,email,'First Employer'),null);assert.ok(storedCredential(second,email,'Second Employer'));
 assert.equal(storedCredential('https://career10.successfactors.com/career',email,'Unrelated Employer'),null);
 let current=second;
 const bound={...state,job:{...state.job,company:'Second Employer'},page:{url:()=>current}} as unknown as ToolContext;
 authenticationAccountSummary(bound);assert.equal(bound.authenticationRealm,`https://${employerAccountSite(second,'Second Employer')}`);
 current='https://career10.successfactors.com/career';assert.match(authenticationAccountSummary(bound),/TenantB/,'company-less redirects preserve the observed tenant rather than guessing from a shared hostname');
 assert.ok(!readFileSync(join(directory,'site-credentials.json'),'utf8').includes(original),'only derivation metadata is persisted');

 // The live decision loop exposes saved-account status before its first model decision.
 await page.goto('https://new-account.fixture.invalid/login');await page.evaluate(()=>{(window as any).writes=0;});
 let calls=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body)),specialist=specialistFixtureReply(body);if(specialist)return specialist;
  if(calls===0){assert.match(JSON.stringify(body.messages),/EMPLOYER ACCOUNT CHECK/);assert.match(JSON.stringify(body.messages),/accepted/);assert.equal(await page.evaluate(()=>(window as any).writes),0);}
  const call=calls++===0?{name:'fill_authentication_fields',args:{purpose:'sign_in',reason:'Reuse the saved employer account.',...fields}}:{name:'finish',args:{status:'skipped',reason:'Controlled account-reuse fixture completed.',evidence:'Employer account'}};
  return Response.json({usage:{prompt_tokens:0,completion_tokens:0},choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'parent-'+calls,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
 };
 const input=await ctx();await runAgentOnlyApplication({simulation:'isolated-form',page,job:input.job,profile:input.profile,log:()=>{}});
 assert.equal(await page.locator('#password').inputValue(),original);assert.equal(calls,2);
 console.log('PASS: account-first lookup, exact credential reuse, no duplicate registration, grounded manual-account handoff, pending activation, durable restart and independent SuccessFactors tenant rejection. Synthetic browser/model only; no employer requests or sends.');
}finally{globalThis.fetch=previousFetch;await browser.close();rmSync(directory,{recursive:true,force:true});}
