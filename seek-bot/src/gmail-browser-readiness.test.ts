import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { chromium } from 'patchright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  }finally{release();stop();await context.close();rmSync(dir,{recursive:true,force:true});}
});
