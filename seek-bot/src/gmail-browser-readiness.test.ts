import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { chromium } from 'patchright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { registerGmailBrowser, searchBrowserGmail } from './gmail-browser.js';

test('mailbox readiness uses the real signed-in view even when DOMContentLoaded is stalled', { timeout: 12_000 }, async () => {
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const dir=mkdtempSync(join(tmpdir(),'owtomate-mail-readiness-'));
  const context=await chromium.launchPersistentContext(dir,{headless:true,args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
  let release!:()=>void;
  const blocked=new Promise<void>(r=>{release=r;});
  const stop=registerGmailBrowser('readiness-fixture',port,'candidate@fixture.invalid');
  try{
    await context.route('**/*',async route=>{
      if(new URL(route.request().url()).pathname==='/deferred.js'){
        await blocked;await route.fulfill({contentType:'application/javascript',body:''}).catch(()=>{});return;
      }
      await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><script defer src="/deferred.js"></script></head><body><a aria-label="Google Account: candidate@fixture.invalid"></a><main role="main"><table><tr data-legacy-thread-id="fixturethread"><td>Verification</td></tr></table></main></body></html>'});
    });
    const result=await Promise.race([searchBrowserGmail('readiness-fixture','verification'),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('A ready mailbox was blocked by an unrelated deferred script')),4000);timer.unref();})]);
    assert.deepEqual(result,[{id:'fixturethread'}]);
  }finally{release();stop();await context.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true});}
});


test('a transient empty search cannot hide an email rendered after the Gmail shell', { timeout: 12_000 }, async () => {
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const dir=mkdtempSync(join(tmpdir(),'owtomate-mail-delayed-search-'));
  const context=await chromium.launchPersistentContext(dir,{headless:true,args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
  const stop=registerGmailBrowser('delayed-search-fixture',port,'candidate@fixture.invalid');
  try {
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><a aria-label="Google Account: candidate@fixture.invalid"></a><main role="main"><p>No conversations match your search.</p></main><script>setTimeout(()=>{document.querySelector('main').innerHTML='<table><tr data-legacy-thread-id="deliveredthread"><td>Verification message</td></tr></table>';},2500);</script>`}));
    assert.deepEqual(await searchBrowserGmail('delayed-search-fixture','fictional verification'),[{id:'deliveredthread'}]);
  } finally { stop();await context.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true}); }
});


test('an explicitly empty Gmail search stays empty after its render window', { timeout: 22_000 }, async () => {
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const dir=mkdtempSync(join(tmpdir(),'owtomate-mail-empty-search-'));
  const context=await chromium.launchPersistentContext(dir,{headless:true,args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
  const stop=registerGmailBrowser('empty-search-fixture',port,'candidate@fixture.invalid');
  try {
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><a aria-label="Google Account: candidate@fixture.invalid"></a><main role="main"><p>No conversations found.</p></main>'}));
    assert.deepEqual(await searchBrowserGmail('empty-search-fixture','fictional absent verification'),[]);
  } finally { stop();await context.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true}); }
});
