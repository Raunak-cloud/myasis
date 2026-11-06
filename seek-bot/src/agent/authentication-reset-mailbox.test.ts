import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {GmailMcpService} from '../gmail-mcp-service.js';
import {withApplicationModel} from '../application-model.js';
import {storedCredential,employerCredentialState} from '../site-credentials.js';
import {doCheckEmployerAccount,doCompleteAuthentication,doOpenEmailedLink,doRecordAuthenticationResult} from './authentication.js';
import type {ToolContext} from './context.js';
import {observe} from './observe.js';

test('existing-account recovery requires a matching inbox and a consumed employer reset message before any password replacement',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mailbox-account-recovery-'));
 const names=['GMAIL_MCP_URL','GMAIL_MCP_TOKEN','GMAIL_MCP_ACCOUNT','GMAIL_ACCESS_MODE','SITE_AUTH_SECRET'] as const;
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const email='candidate@fixture.invalid',company='Fixture Employer';
 const destination='https://career41.sapsf.com/career?company=fixtureTenant&login_ns=pwd_reset&verify=fictional-reset-token';
 const gateway=new GmailMcpService({search:async()=>[{id:'fixture-thread'}],thread:async()=>[{id:'fixture-message',sender:'system@successfactors.com',subject:'Password Reset',date:new Date().toISOString(),plaintextBody:'Please click on the URL below to change your password.',htmlBody:`<a href="${destination}">Click Here</a>`}],send:async()=>{throw Error('No email sends in recovery fixture');}});
 const lease=await gateway.grant('fixture-owner',email);
 Object.assign(process.env,{GMAIL_MCP_URL:lease.connection.url,GMAIL_MCP_TOKEN:lease.connection.token,GMAIL_MCP_ACCOUNT:email,GMAIL_ACCESS_MODE:'mcp',SITE_AUTH_SECRET:'fictional-reset-secret-only'});
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{await withApplicationModel({DATA_DIR:directory},async()=>{
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main><p>An account already exists with this email. Please sign in.</p><label>Email<input id=email type=email></label><label>Password<input id=password type=password></label></main>'}));
  const page=await context.newPage();await page.goto('https://career41.sapsf.com/career?company=fixtureTenant');
  const ctx={page,job:{id:'fictional',company,title:'Fixture',url:page.url()},profile:{name:'Fixture Candidate',email},observation:await observe(page),actions:[],captured:[],log:()=>{}} as unknown as ToolContext;
  const fields={targets:[{selector:'#email'},{selector:'#password'}]};
  const existing=await doCheckEmployerAccount(ctx,{outcome:'existing',evidence:'An account already exists with this email. Please sign in.'});
  assert.equal(existing.kind,'ok');assert.match(existing.kind==='ok'?existing.message:'',/fresh reset email/);
  assert.equal(employerCredentialState(page.url(),email,company).state,'external');
  await doCompleteAuthentication(ctx,{purpose:'sign_in',...fields});assert.equal(await page.locator('#password').inputValue(),'','never guess an existing password');
  await doCompleteAuthentication(ctx,{purpose:'reset_password',...fields});assert.equal(await page.locator('#password').inputValue(),'','a connected inbox alone cannot authorize a new password');
  await doOpenEmailedLink(ctx,{purpose:'reset_password',sender_hint:'SuccessFactors'});
  await ctx.page.goto('https://career41.sapsf.com/career?company=otherTenant');
  await doCompleteAuthentication(ctx,{purpose:'reset_password',...fields});assert.equal(await ctx.page.locator('#password').inputValue(),'','email proof cannot transfer across SAP tenants even with the same employer label');
  await ctx.page.goto(destination);
  process.env.GMAIL_MCP_ACCOUNT='different@fixture.invalid';
  await doCompleteAuthentication(ctx,{purpose:'reset_password',...fields});assert.equal(await ctx.page.locator('#password').inputValue(),'','proof cannot survive an account mismatch');
  process.env.GMAIL_MCP_ACCOUNT=email;
  const unrelated={...ctx,job:{...ctx.job,company:'Other Employer'}};
  await doCompleteAuthentication(unrelated,{purpose:'reset_password',...fields});assert.equal(await ctx.page.locator('#password').inputValue(),'','proof cannot transfer to another employer/context');
  const fill=await doCompleteAuthentication(ctx,{purpose:'reset_password',...fields});
  const password=await ctx.page.locator('#password').inputValue();assert.ok(password.length>=12);assert.ok(!JSON.stringify(fill).includes(password));
  assert.equal(storedCredential(ctx.page.url(),email,company),null,'filling is not acceptance');
  await ctx.page.setContent('<p>Your password has been reset successfully.</p>');
  await doRecordAuthenticationResult(ctx,{purpose:'reset_password',outcome:'accepted',evidence:'Your password has been reset successfully.'});
  assert.ok(storedCredential(ctx.page.url(),email,company));
  assert.equal(storedCredential(ctx.page.url(),'different@fixture.invalid',company),null);
  assert.equal(ctx.actions.some(action=>action.kind==='signed-in'),false,'reset acceptance does not invent a signed-in session');
 });}finally{
  await browser.close();lease.revoke();await gateway.close();
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  rmSync(directory,{recursive:true,force:true});
 }
});
