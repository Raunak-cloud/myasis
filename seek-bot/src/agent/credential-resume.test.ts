import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'patchright';
const directory=mkdtempSync(join(tmpdir(),'credential-resume-'));
Object.assign(process.env,{DATA_DIR:directory,SITE_AUTH_SECRET:'fixture-resume-secret',DRY_RUN:'true'});
const {doCompleteAuthentication:fill,doCheckEmployerAccount:check,doRecordAuthenticationResult:record}=await import('./authentication.js');
const {pendingCredential,storedCredential,stagePendingCredential}=await import('../site-credentials.js');
const {observe}=await import('./observe.js');
const {sitePassword}=await import('../site-auth.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
const email='candidate@fixture.invalid',company='Fixture Employer',url='https://resume.fixture.invalid/register';
const html='<main><p>Account already exists. Sign in.</p><label>Username<input id=username></label><label>Email<input id=email type=email></label><label>Password<input id=password type=password></label></main>';
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto(url);
 const ctx=async()=>({page,job:{id:'fixture',company},profile:{email,name:'Fixture Candidate'},observation:await observe(page,{screenshot:false}),actions:[],captured:[],log:()=>{}} as any);
 const fields={targets:[{selector:'#username'},{selector:'#email'},{selector:'#password'}]};
 await page.locator('#username').fill('candidate.login42');
 let c=await ctx();await fill(c,{purpose:'create_account',...fields});
 const password=await page.locator('#password').inputValue();assert.ok(password);assert.equal(await page.locator('#username').inputValue(),'candidate.login42');assert.equal(await page.locator('#email').inputValue(),email);
 assert.equal(pendingCredential(url,email,company,'create_account')?.username,'candidate.login42');assert.equal(storedCredential(url,email,company),null);
 // A separate Node process must recover exactly the same pending login.
 const moduleUrl=new URL('../site-credentials.js',import.meta.url).href,authUrl=new URL('../site-auth.js',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {pendingCredential} from ${JSON.stringify(moduleUrl)};import {sitePassword} from ${JSON.stringify(authUrl)};const p=pendingCredential(${JSON.stringify(url)},${JSON.stringify(email)},${JSON.stringify(company)},'create_account');process.stdout.write(JSON.stringify({username:p?.username,password:sitePassword(${JSON.stringify(url)},${JSON.stringify(email)},undefined,p)}));`],{env:process.env,encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{username:'candidate.login42',password});
 c=await ctx();const existing=await check(c,{outcome:'existing',evidence:'Account already exists. Sign in.'});assert.equal(existing.kind,'ok');assert.ok(pendingCredential(url,email,company,'create_account'),'an existing-account response must preserve our interrupted registration');
 await page.setContent(html);c=await ctx();await fill(c,{purpose:'sign_in',use_pending:true,...fields});assert.equal(await page.locator('#username').inputValue(),'candidate.login42');assert.equal(await page.locator('#password').inputValue(),password);assert.equal(storedCredential(url,email,company),null);
 await record(c,{purpose:'sign_in',outcome:'needs_verification',evidence:'Verify your email to continue.'});assert.equal(pendingCredential(url,email,company,'create_account')?.phase,'needs_verification');
 await record(c,{purpose:'sign_in',outcome:'rejected',evidence:'Activation is still pending.'});assert.ok(pendingCredential(url,email,company,'create_account'));assert.equal(storedCredential(url,email,company),null);
 await page.setContent(html);c=await ctx();await fill(c,{purpose:'sign_in',use_pending:true,...fields});await record(c,{purpose:'sign_in',outcome:'accepted',evidence:'The account dashboard is now open.'});
 assert.equal(storedCredential(url,email,company)?.username,'candidate.login42');assert.equal(pendingCredential(url,email,company,'create_account'),null);
 await page.setContent(html);c=await ctx();await fill(c,{purpose:'sign_in',...fields});assert.equal(await page.locator('#username').inputValue(),'candidate.login42');assert.equal(await page.locator('#email').inputValue(),email);assert.equal(await page.locator('#password').inputValue(),password);
 // A pending reset never silently replaces the accepted password. The agent explicitly chooses it.
 stagePendingCredential(url,email,company,'reset_password',{format:'readable-v1',username:'candidate.login42',rules:{max_length:18}});
 const reset=sitePassword(url,email,undefined,pendingCredential(url,email,company,'reset_password'));assert.notEqual(reset,password);
 c=await ctx();await fill(c,{purpose:'sign_in',...fields});assert.equal(await page.locator('#password').inputValue(),password);
 c=await ctx();await fill(c,{purpose:'sign_in',use_pending:true,...fields});assert.equal(await page.locator('#password').inputValue(),reset);
 await record(c,{purpose:'sign_in',outcome:'rejected',evidence:'Reset still needs verification.'});assert.equal(sitePassword(url,email,undefined,storedCredential(url,email,company)),password,'a failed pending-login attempt cannot reject the accepted password');
 assert.equal(storedCredential(url,'other@fixture.invalid',company),null);
 console.log('PASS: observed separate username, restart recovery, durable pending activation, duplicate discovery preservation, agent-selected pending sign-in, acceptance promotion, email separation and rejected-reset isolation. Synthetic browser only.');
}finally{await browser.close();rmSync(directory,{recursive:true,force:true});}
