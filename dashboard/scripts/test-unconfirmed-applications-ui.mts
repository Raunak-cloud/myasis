/** Actual application UI with fictional APIs; no candidate, employer or DB writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const initial=[{jobId:'same-id',platform:'external',title:'Dog walker',company:'Fixture Dogs',location:'Sydney',url:'https://fixture.invalid/job',appliedAt:new Date(Date.now()-20*86400_000).toISOString(),score:80,confirmationStatus:'unconfirmed',external:true},
 {jobId:'same-id',platform:'indeed',title:'Other board role',company:'Other board employer',location:'Sydney',url:'https://fixture.invalid/other',appliedAt:new Date().toISOString(),score:80}];
let applications:any[]=initial;const writes:any[]=[];
const html=`<!doctype html><html><body><div id="root"></div><script type="module">import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ApplicationsPanel}from'/src/components/ApplicationsPanel.tsx';import'/src/index.css';function Fixture(){const[apps,setApps]=useState(${JSON.stringify(initial)});return React.createElement(ApplicationsPanel,{apps,onChange:setApps,followUpDays:10});}createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script></body></html>`;
const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'uncertain-applications-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url==='/uncertain-preview.html'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,html));return;}
 if(!req.url?.startsWith('/api/'))return next();
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/applications'&&req.method==='PATCH'){
  let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);writes.push(value);
  applications=applications.map(row=>row.jobId===value.jobId&&row.platform===value.platform?{...row,outcome:value.patch.outcome,confirmationStatus:undefined}:row);
  res.end(JSON.stringify({ok:true,applications}));return;
 }
 res.end(JSON.stringify([]));
});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await vite.listen();const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{executablePath:'/usr/bin/google-chrome-stable'})});
try{
 const page=await browser.newPage({viewport:{width:1150,height:950}});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin+'/uncertain-preview.html');const row=page.locator('.application-item').filter({hasText:'Fixture Dogs'});
 await row.waitFor();assert.match(await row.innerText(),/Unconfirmed/);await row.click();
 const drawer=page.locator('.drawer');assert.match(await drawer.innerText(),/confirm the application reached the employer/);
 assert.doesNotMatch(await drawer.innerText(),/Sent 20 days ago/,'an uncertain attempt must not acquire a confirmed-send follow-up claim');
 assert.equal(await drawer.getByRole('button',{name:'No longer interested',exact:true}).count(),0);
 await drawer.getByRole('button',{name:'Interview',exact:true}).click();
 await drawer.waitFor({state:'hidden'});assert.equal(writes.length,1);assert.deepEqual(writes[0],{jobId:'same-id',platform:'external',patch:{outcome:'interview'}});
 assert.match(await row.innerText(),/Interview/);assert.doesNotMatch(await row.innerText(),/Unconfirmed/);
 assert.equal(applications.find(row=>row.platform==='indeed').outcome,undefined,'same id on another board remains unchanged');
 await page.locator('.queue-bar .chip').filter({hasText:/^Interview/}).click();assert.equal(await page.locator('.application-item').count(),1);
 await page.setViewportSize({width:390,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 console.log('PASS: visible unconfirmed row, candidate interview confirmation, platform-scoped update, Interview filter and mobile layout; fixture-only API write.');
}finally{await browser.close();await vite.close();}
