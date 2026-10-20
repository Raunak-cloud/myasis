import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

const dashboard=resolve(import.meta.dirname,'..');
const fixture='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account Settings fixture</title></head><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{EmailAlertsToggle,DailySummaryToggle}from"/src/components/EmailAlertsToggle.tsx";import{DeleteAccount}from"/src/components/DeleteAccount.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.Fragment,null,React.createElement(EmailAlertsToggle),React.createElement(DailySummaryToggle),React.createElement(DeleteAccount)));</script><style>#fixture{display:grid;gap:16px;max-width:800px;margin:24px auto;padding:16px;box-sizing:border-box;width:100%}body{margin:0}#fixture>section,#fixture>div{min-width:0}</style></body></html>';
const server=await createServer({configFile:false,root:dashboard,plugins:[react(),{
  name:'account-settings-fixture',configureServer(server) {
    server.middlewares.use(async(req,res,next)=>{
      if(req.url?.split('?')[0]!=='/account-settings-fixture.html') return next();
      res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml('/account-settings-fixture.html',fixture));
    });
  },
}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();
const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
try {
  mkdirSync(resolve(dashboard,'../output'),{recursive:true});
  for(const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    let daily=true,alerts=true,failSave=false,failLoad=false,deletionAttempts=0;
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin) return route.abort();
      if(url.searchParams.get('account')==='deleted') return route.fulfill({contentType:'text/html',body:'<p>Account deleted fixture</p>'});
      if(!url.pathname.startsWith('/api/')) return route.continue();
      const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      const method=route.request().method();
      if(url.pathname==='/api/account') {
        if(method==='GET') return json({email:'fixture@example.test'});
        assert.deepEqual(route.request().postDataJSON(),{confirmEmail:'fixture@example.test'});
        deletionAttempts++;
        return deletionAttempts===1?json({error:'A website research task is finishing. Please try again shortly.'},409):json({ok:true});
      }
      if(url.pathname==='/api/daily-summary' || url.pathname==='/api/email-alerts') {
        const summary=url.pathname==='/api/daily-summary';
        if(summary && method==='GET' && failLoad) {failLoad=false;return json({error:'Fixture load outage'},503);}
        if(method==='POST') {
          if(failSave) {failSave=false;return json({error:'Fixture save outage'},503);}
          const enabled=route.request().postDataJSON().enabled;
          if(summary) daily=enabled;else alerts=enabled;
        }
        return json({enabled:summary?daily:alerts});
      }
      throw new Error('Unexpected fixture request '+url.pathname);
    });
    await page.goto(origin+'/account-settings-fixture.html');
    const summary=page.getByRole('switch',{name:'Email me my daily summary',exact:true});
    const attention=page.getByRole('switch',{name:'Email me when something needs my attention',exact:true});
    await summary.waitFor();
    await page.waitForFunction("document.querySelector('[aria-label=\"Email me my daily summary\"]')?.getAttribute('aria-checked')==='true'");
    await summary.click();
    await page.waitForFunction("document.querySelector('[aria-label=\"Email me my daily summary\"]')?.getAttribute('aria-checked')==='false'");
    assert.equal(await attention.getAttribute('aria-checked'),'true');
    await page.reload();
    await summary.waitFor();
    await page.waitForFunction("!document.querySelector('[aria-label=\"Email me my daily summary\"]')?.disabled");
    assert.equal(await summary.getAttribute('aria-checked'),'false','opt-out survives reload');
    failSave=true;await summary.click();
    await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();
    assert.equal(await summary.getAttribute('aria-checked'),'false','a rejected save never presents an unsaved choice');
    await summary.click();
    await page.waitForFunction("document.querySelector('[aria-label=\"Email me my daily summary\"]')?.getAttribute('aria-checked')==='true'");
    await attention.click();
    await page.waitForFunction("document.querySelector('[aria-label=\"Email me when something needs my attention\"]')?.getAttribute('aria-checked')==='false'");
    assert.equal(await summary.getAttribute('aria-checked'),'true');
    failLoad=true;await page.reload();
    await page.getByRole('alert').filter({hasText:'Could not load'}).waitFor();
    assert.equal(await summary.isDisabled(),true);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.waitForFunction("document.querySelector('[aria-label=\"Email me my daily summary\"]')?.getAttribute('aria-checked')==='true'");
    await page.getByRole('button',{name:'Delete my account',exact:true}).click();
    const dialog=page.getByRole('alertdialog');await dialog.waitFor();
    const remove=page.getByRole('button',{name:'Permanently delete account',exact:true});
    assert.equal(await remove.isDisabled(),true);
    await page.getByLabel('Your account email',{exact:true}).fill('someone-else@example.test');
    assert.equal(await remove.isDisabled(),true);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await dialog.count(),0);assert.equal(deletionAttempts,0);
    await page.getByRole('button',{name:'Delete my account',exact:true}).click();
    await page.getByLabel('Your account email',{exact:true}).fill('fixture@example.test');
    assert.equal(await remove.isDisabled(),false);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Settings must fit mobile and desktop');
    await page.screenshot({path:resolve(dashboard,`../output/account-settings-${width}.png`),fullPage:true});
    await remove.click();
    await page.getByRole('alert').filter({hasText:'research task'}).waitFor();
    assert.equal(await dialog.count(),1,'failed deletion keeps confirmation available for retry');
    await remove.click();
    await page.waitForURL('**/?account=deleted');
    assert.equal(deletionAttempts,2);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('PASS: desktop/mobile Settings, independent email switches, persistence, loading/saving failures, typed deletion confirmation, cancel, retry and sign-out redirect; simulated APIs only.');
} finally {await browser.close();await server.close();}
