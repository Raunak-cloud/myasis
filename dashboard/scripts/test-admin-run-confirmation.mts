/** Real component/browser, fixture APIs only. No production applications. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const root=resolve(import.meta.dirname,'..');
const html='<html><body><div id="fixture"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{AdminPanel}from"/src/components/AdminPanel.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.StrictMode,null,React.createElement(AdminPanel)));</script></body></html>';
const server=await createServer({configFile:false,root,plugins:[react(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/fixture.html')return next();res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml('/fixture.html',html));});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{errors.push('Unexpected native dialog');await d.dismiss();});
  const user={id:'999',email:'fixture@example.invalid',name:'Fixture User',createdAt:new Date().toISOString(),lastLoginAt:null,blockedAt:null,admin:false,plan:'Get Owtomated',allowance:{freeRemaining:5,paidRemaining:0,paidExpiresAt:null,unlimited:true},setupMissing:[],emailedAt:null,resumes:1,boards:{seek:true,indeed:true},autoApply:{runsPerDay:4,usedToday:0,paused:false,canPause:true,nextRunAt:null,applicationMode:'semi-auto'},overrides:{evaluationsPerRun:null,maxApplicationsPerRun:null},applicationModel:'celeris',route:{homePort:null,proxy:null,pooled:null,status:{}},applications:{total:0,week:0,today:0},lastRun:null,running:false,signingIn:false,preferences:[],passes:[],runs:[],recentApplications:[]};
  const writes:Array<{path:string;body:unknown}>=[];let fail=true;let release:(()=>void)|undefined;
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()==='POST'){
    writes.push({path,body:req.postDataJSON()});
    if(fail)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture unavailable"}'});
    if(path.endsWith('/run'))await new Promise<void>(resolve=>{release=resolve;});
    user.running=!path.endsWith('/stop');
    return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
   }
   if(path.endsWith('/overview'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture overview"}'});
   const body=path.endsWith('/users')?[user]:path.endsWith('/999')?user:path.endsWith('/repair-preview')?{applications:[]}:path.endsWith('/dashboard')?{userId:user.id,email:user.email,attention:[],applications:[]}:null;
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/fixture.html`);
  await page.getByRole('button',{name:'Users',exact:true}).click();await page.getByRole('cell',{name:'Fixture User fixture@example.invalid',exact:true}).click();
  await page.getByRole('checkbox',{name:/Recover eligible/}).uncheck();
  const start=page.getByRole('button',{name:'Start run',exact:true}),dialog=page.getByRole('alertdialog');
  await start.click();await dialog.waitFor();assert.match(await dialog.innerText(),/prepared for confirmation/);assert.equal(writes.length,0);
  assert.equal(await dialog.getByRole('button',{name:'Cancel'}).evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await dialog.getByRole('button',{name:'Start run'}).evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(writes.length,0);
  await start.click();await dialog.getByRole('button',{name:'Cancel'}).click();assert.equal(writes.length,0);
  await start.click();await dialog.getByRole('button',{name:'Start run'}).click();await page.getByRole('alert').filter({hasText:'Fixture unavailable'}).waitFor();
  assert.deepEqual(writes[0],{path:'/api/admin/users/999/run',body:{applicationMode:'semi-auto',repairPriorRuns:false}});
  fail=false;await start.click();await dialog.getByRole('button',{name:'Start run'}).dblclick();
  await page.getByRole('button',{name:'Starting…',exact:true}).waitFor();assert.equal(writes.length,2);release!();await page.getByRole('button',{name:'Stop run',exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop run',exact:true}).click();await dialog.getByRole('button',{name:'Stop run'}).click();await start.waitFor();assert.deepEqual(writes.at(-1),{path:'/api/admin/users/999/stop',body:{}});
  await page.getByRole('button',{name:'Job boards only',exact:true}).click();await dialog.getByRole('button',{name:'Start run'}).click();await page.getByRole('button',{name:'Starting…',exact:true}).waitFor();release!();await page.getByRole('button',{name:'Stop run',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1),{path:'/api/admin/users/999/run',body:{applicationMode:'semi-auto',scope:'hosted'}});
  await page.getByRole('button',{name:'Stop run',exact:true}).click();await dialog.getByRole('button',{name:'Stop run'}).click();await start.waitFor();
  await page.getByLabel('External job URL',{exact:true}).fill('https://careers.example.invalid/job/42');await page.getByRole('button',{name:'Apply to URL',exact:true}).click();
  assert.match(await dialog.innerText(),/can submit a real application/);await dialog.getByRole('button',{name:'Apply to URL'}).click();await page.getByRole('button',{name:'Starting…',exact:true}).waitFor();release!();await page.getByRole('button',{name:'Stop run',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1),{path:'/api/admin/users/999/run',body:{externalUrl:'https://careers.example.invalid/job/42'}});
  await page.getByRole('button',{name:'Stop run',exact:true}).click();await dialog.getByRole('button',{name:'Stop run'}).click();await start.waitFor();
  await page.getByRole('checkbox',{name:/Recover eligible/}).check();await start.click();assert.match(await dialog.innerText(),/previously approved applications may be submitted/);await dialog.getByRole('button',{name:'Cancel'}).click();
  user.autoApply.applicationMode='auto';await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('cell',{name:'Fixture User fixture@example.invalid',exact:true}).click();await page.getByRole('checkbox',{name:/Recover eligible/}).uncheck();await start.click();assert.match(await dialog.innerText(),/can submit real applications/);await dialog.getByRole('button',{name:'Cancel'}).click();
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px: cancel, Escape, focus, Semi auto, failed retry, duplicate click, stop and hosted scope; no native dialogs.`);await page.close();
 }
}finally{await browser.close();await server.close();}
