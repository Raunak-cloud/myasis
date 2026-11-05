/** Real component, local browser, synthetic HTTP responses. No accounts or jobs touched. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {normaliseJob} from '../server/job-index/extract.js';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const html='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{JobIndexView}from"/src/components/JobIndexView.tsx";import"/src/index.css";createRoot(document.getElementById("root")).render(React.createElement(JobIndexView));</script>';
const server=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'job-index-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/job-index-fixture.html')return next();res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml(req.url,html));});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome-stable'})});
const job=normaliseJob({title:'Graduate Data Analyst',hiringOrganization:{name:'Fixture employer'},description:'Graduate role using Python and SQL. Students welcome. Hybrid working in Sydney.',jobLocation:{name:'Sydney'},baseSalary:{currency:'AUD',value:{minValue:75000,maxValue:90000,unitText:'YEAR'}}},'https://careers.fixture.org/jobs/1')!;
let enabled=true;const reads:string[]=[];const errors:string[]=[];
try{
 const page=await browser.newPage({viewport:{width:1360,height:1000}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){assert.equal(url.pathname,'/api/admin/job-index/control');enabled=req.postDataJSON().enabled;return route.fulfill({json:{ok:true}});}
  reads.push(url.search);return route.fulfill({json:url.pathname.endsWith('/status')?{enabled,searchConfigured:false,counts:{jobs:1,fresh_jobs:1},profiles:2,cycles:[]}:{jobs:[{payload:job,verified_at:'2026-11-05T00:00:00Z',candidate_match:null}],hasMore:false}});
 });
 await page.goto(origin+'/job-index-fixture.html');await page.getByRole('link',{name:'Graduate Data Analyst'}).waitFor();
 assert.ok(await page.getByText('hybrid · AUD 75,000–90,000 / year',{exact:true}).isVisible());
 await page.getByLabel('Work arrangement').selectOption('hybrid');await page.getByLabel('Account ID for private matches').fill('183');
 await page.waitForResponse(r=>r.url().includes('arrangement=hybrid')&&r.url().includes('user=183'));
 assert.ok(reads.some(q=>q.includes('user=183')&&q.includes('arrangement=hybrid')));
 await page.getByRole('button',{name:'Pause crawler'}).click();await page.getByRole('button',{name:'Resume crawler'}).waitFor();assert.equal(enabled,false);
 const output=resolve(import.meta.dirname,'../../output/job-index-preview');mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,'desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.getByText('Job details',{exact:true}).click();assert.ok(await page.getByText('Students',{exact:false}).first().isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile layout must not overflow');await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS: admin job search, account/arrangement filters, pay display, pause/resume and mobile layout. Synthetic APIs only.');
}finally{await browser.close();await server.close();}
