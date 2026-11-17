import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hrBrowserStep,hrBrowserFailure} from './hr-browser-diagnostics.js';
import {openHrGmail} from './hr-email-browser.js';
import {chromium} from 'patchright';

test('browser diagnostics preserve failure identity, precise nested step and cause through transport wrapping',async()=>{
  const original=Object.assign(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://mail.google.com/mail/u/?authuser=private@example.org'),{code:'ECONNRESET'});
  let calls=0;
  await assert.rejects(hrBrowserStep('mailbox',()=>hrBrowserStep('gmail_navigation',async()=>{calls++;throw original;})),error=>error===original);
  const result=hrBrowserFailure(new Error('private browser unavailable',{cause:original}));
  assert.equal(calls,1);assert.equal(result?.step,'gmail_navigation');assert.equal(result.category,'proxy_connection_failed');assert.equal(result.errorCode,'ERR_TUNNEL_CONNECTION_FAILED');assert.ok(result.elapsedMs>=0);
  assert.doesNotMatch(JSON.stringify(result),/private@example|authuser|google\.com/);
});

test('Chrome launch reasons are retained even when its first line only says the browser closed',async()=>{
  for(const [detail,category] of [
    ['ProcessSingleton: profile is in use','profile_in_use'],['Missing X server or $DISPLAY','display_unavailable'],
    ["Executable doesn't exist at /home/private/chrome",'browser_executable_missing'],['ENOMEM: out of memory','out_of_memory'],
  ]){
    const error=new Error(`browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=123][err] ${detail}\n<launching> --proxy-server=https://user:password@private.example --token=private-token`);
    await assert.rejects(hrBrowserStep('launch',async()=>{throw error;}));
    const result=hrBrowserFailure(error);assert.equal(result?.category,category);assert.equal(result.step,'launch');assert.equal(result.browserLog?.length,1);assert.doesNotMatch(JSON.stringify(result),/private|proxy-server|private-token/);
  }
});

test('unrecognised errors keep a bounded redacted original first line and do not acquire a guessed cause',async()=>{
  const error=new Error('unexpected token=secret-value password="secret password" Authorization=secret-auth /home/person/profile person@example.org https://user:pass@host/a?code=private\nPRIVATE PAGE CONTENT');
  await assert.rejects(hrBrowserStep('launch',async()=>{throw error;}));
  const result=hrBrowserFailure(error);assert.equal(result?.category,'unclassified_browser_error');assert.doesNotMatch(JSON.stringify(result),/secret-value|secret password|secret-auth|\/home\/person|person@example|user:pass|code=private|PRIVATE PAGE/);
  assert.equal(hrBrowserFailure(new Error('not a browser failure')),undefined);
});

test('Gmail navigation and mailbox-ready failures are distinguished without sending or retrying',async()=>{
  for(const failAt of ['navigation','ready']){
    const original=Object.assign(new Error(failAt==='navigation'?'page.goto: net::ERR_NAME_NOT_RESOLVED':'locator.waitFor: Timeout 30000ms exceeded.'),{name:failAt==='ready'?'TimeoutError':'Error'});
    let navigations=0,waits=0;
    const page={goto:async()=>{navigations++;if(navigations===2&&failAt==='navigation')throw original;},locator:()=>({waitFor:async()=>{waits++;throw original;}})};
    await assert.rejects(openHrGmail(page as any,'candidate@example.org'),error=>error===original);
    const result=hrBrowserFailure(original);assert.equal(result?.step,failAt==='navigation'?'gmail_navigation':'mailbox_ready');assert.equal(result.category,failAt==='navigation'?'dns_failure':'timeout');assert.equal(navigations,2);assert.equal(waits,failAt==='ready'?1:0);
  }
});

test('successful instrumentation returns the exact result and does not add actions',async()=>{
  const result={id:'receipt'};let calls=0;assert.equal(await hrBrowserStep('mailbox',async()=>{calls++;return result;}),result);assert.equal(calls,1);
});

test('a real Playwright launch error keeps the missing executable cause without exposing its path',async()=>{
 let failure:unknown;
 try{await hrBrowserStep('launch',()=>chromium.launch({executablePath:'/nonexistent-hr-diagnostic-fixture/chrome',headless:true}));}catch(error){failure=error;}
 assert.ok(failure);const diagnostic=hrBrowserFailure(failure);assert.equal(diagnostic?.category,'browser_executable_missing');assert.match(diagnostic.message,/executable/i);assert.doesNotMatch(diagnostic.message,/nonexistent-hr/);
});

test('real Chromium Gmail navigation failure retains the native network code', {skip:!process.env.CHROME_PATH}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.route('https://mail.google.com/**',route=>route.abort('connectionrefused'));
  let failure:unknown;try{await openHrGmail(page,'candidate@example.org');}catch(error){failure=error;}
  assert.ok(failure);const diagnostic=hrBrowserFailure(failure);assert.equal(diagnostic?.step,'gmail_navigation');assert.equal(diagnostic.errorCode,'ERR_CONNECTION_REFUSED');assert.equal(diagnostic.category,'connection_failed');assert.doesNotMatch(JSON.stringify(diagnostic),/candidate@example|authuser/);
 }finally{await browser.close();}
});
