import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {GmailMcpService} from '../gmail-mcp-service.js';
import {withApplicationModel} from '../application-model.js';
import {storedCredential,employerCredentialState} from '../site-credentials.js';
import {doCheckEmployerAccount,doCompleteAuthentication} from './authentication.js';
import type {ToolContext} from './context.js';
import {observe} from './observe.js';

test('existing accounts without a verified login are skipped even with a connected inbox',async()=>{
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
  assert.equal(existing.kind,'terminal');
  if(existing.kind==='terminal') assert.equal(existing.outcome.status,'skipped');
  assert.equal(employerCredentialState(page.url(),email,company).state,'external');
  for (const purpose of ['sign_in','reset_password','create_account']) {
   const result=await doCompleteAuthentication(ctx,{purpose,...fields});
   assert.equal(result.kind,'terminal');
   if(result.kind==='terminal') assert.equal(result.outcome.status,'skipped');
   assert.equal(await page.locator('#password').inputValue(),'');
  }
  assert.equal(storedCredential(page.url(),email,company),null);

 });}finally{
  await browser.close();lease.revoke();await gateway.close();
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  rmSync(directory,{recursive:true,force:true});
 }
});
