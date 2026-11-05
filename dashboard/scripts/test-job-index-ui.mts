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
const appHtml='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import App from"/src/App.tsx";import"/src/index.css";createRoot(document.getElementById("root")).render(React.createElement(App));</script>';
const server=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'job-index-fixture',load(id){if(id.endsWith('/components/RunPanel.tsx'))return `import React from 'react';export const RunPanel=()=>React.createElement('p',null,'Apply fixture');`;},configureServer(s){s.middlewares.use(async(req,res,next)=>{const pathname=new URL(req.url!,'http://fixture').pathname;if(!['/job-index-fixture.html','/jobs-shell-fixture.html'].includes(pathname))return next();res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml(req.url!,pathname==='/jobs-shell-fixture.html'?appHtml:html));});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome-stable'})});
const job=normaliseJob({title:'Graduate Data Analyst',hiringOrganization:{name:'Fixture employer'},description:'Graduate role using Python and SQL. Students welcome. Hybrid working in Sydney.',jobLocation:{name:'Sydney'},baseSalary:{currency:'AUD',value:{minValue:75000,maxValue:90000,unitText:'YEAR'}}},'https://careers.fixture.org/jobs/1')!;
const match={status:'matched',keywords:['Data analyst'],skills:['Python','SQL'],reasons:['Relevant work'],preferences:{arrangement:'compatible',location:'mentioned'},review:{policy:'resume-fit-v1',model:'minimax/minimax-m3.1-flash',score:88,reason:'The duties and candidate evidence align.'}};
const record={payload:{...job,sourceId:'publisher-123',postedAt:'2026-11-01T00:00:00Z',expiresAt:'2026-12-01T00:00:00Z'},first_seen_at:'2026-11-04T00:00:00Z',verified_at:'2026-11-05T00:00:00Z',payload_hash:'fixture-snapshot',candidate_match:null,matches:[{userId:'183',matchedAt:'2026-11-05T00:00:00Z',match}]};
let enabled=true;const reads:string[]=[];const errors:string[]=[];
try{
 const page=await browser.newPage({viewport:{width:1360,height:1000}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()==='POST'){assert.equal(url.pathname,'/api/admin/job-index/control');enabled=req.postDataJSON().enabled;return route.fulfill({json:{ok:true}});}
  reads.push(url.search);return route.fulfill({json:url.pathname.endsWith('/status')?{enabled,searchConfigured:false,counts:{jobs:1,fresh_jobs:1},profiles:2,cycles:[]}:{jobs:[record],hasMore:false}});
 });
 await page.goto(origin+'/job-index-fixture.html');await page.getByRole('link',{name:'Graduate Data Analyst'}).waitFor();
 assert.ok(await page.getByText('AUD 75,000–90,000 / year',{exact:true}).first().isVisible());
 await page.getByLabel('Work arrangement').selectOption('hybrid');await page.getByLabel('Account ID for private matches').fill('183');
 await page.waitForResponse(r=>r.url().includes('arrangement=hybrid')&&r.url().includes('user=183'));
 assert.ok(reads.some(q=>q.includes('user=183')&&q.includes('arrangement=hybrid')));
 await page.getByRole('button',{name:'Pause crawler'}).click();await page.getByRole('button',{name:'Resume crawler'}).waitFor();assert.equal(enabled,false);
 const output=resolve(import.meta.dirname,'../../output/job-index-preview');mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,'desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.getByText('Job details',{exact:true}).click();assert.ok(await page.getByText('Students',{exact:false}).first().isVisible());await page.getByText('88% match',{exact:true}).waitFor();assert.ok(await page.getByText('publisher-123',{exact:true}).isVisible());assert.ok(await page.getByText('First found',{exact:true}).isVisible());await page.getByText('Source evidence and record metadata',{exact:true}).click();assert.ok(await page.getByText('fixture-snapshot',{exact:true}).isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile layout must not overflow');await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});assert.equal(errors.length,0);
 // Exercise the actual app shell: only admins can see or load the Jobs tab.
 for(const admin of [true,false]){
   const context=await browser.newContext({viewport:{width:1360,height:1000}});await context.addInitScript(()=>localStorage.setItem('myasis-signed-in','1'));
   const shell=await context.newPage();const jobReads:string[]=[];shell.setDefaultTimeout(5000);shell.on('pageerror',e=>errors.push(e.message));
   await shell.route('**/*',async route=>{
     const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
     if(url.pathname.startsWith('/api/admin/job-index')){jobReads.push(url.pathname);assert.equal(admin,true,'ordinary accounts must not request the private catalog');return route.fulfill({json:url.pathname.endsWith('/status')?{enabled:true,searchConfigured:true,counts:{jobs:1,fresh_jobs:1},profiles:2}:{jobs:[record],hasMore:false}});}
     const payloads:Record<string,unknown>={
       '/api/auth/me':{user:{id:'fixture',email:'fixture@example.test',name:'Fixture'},googleConfigured:true},
       '/api/entitlements':{tier:admin?'admin':'standard',manualRuns:true,firstRunRequired:false,fineTune:admin,advancedFilters:admin,autoRunsPerDay:1,autoApplyPaused:true},
       '/api/applications':[], '/api/attention':[], '/api/application-reviews':{applications:[]},
       '/api/billing/status':{totalRemaining:5,free:{allowance:5,used:0,remaining:5},paid:{remaining:0,hasActivePass:false,expiresAt:null}},
       '/api/today':{runs:0,reviewed:0,submitted:0},'/api/run/status':{running:false},'/api/signin/session':{seek:{signedIn:false},indeed:{signedIn:false}},
     };
     return route.fulfill({json:payloads[url.pathname]??{}});
   });
   await shell.goto(origin+'/jobs-shell-fixture.html?tab=jobs');
   if(admin){
     await shell.getByRole('heading',{name:'Jobs',exact:true}).waitFor();await shell.getByRole('link',{name:'Graduate Data Analyst'}).waitFor();
     const jobs=shell.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Jobs',exact:true});assert.equal(await jobs.getAttribute('aria-current'),'page');await jobs.click();
     assert.equal(await shell.getByRole('heading',{name:'Jobs',exact:true}).count(),1);assert.ok(jobReads.length>=2);await shell.screenshot({path:resolve(output,'jobs-page-desktop.png')});
     await shell.setViewportSize({width:390,height:844});await shell.getByRole('button',{name:'Menu',exact:true}).click();await jobs.click();await shell.getByRole('button',{name:'Menu',exact:true}).waitFor();await shell.getByRole('region',{name:'Saved jobs'}).waitFor();
     assert.ok(await shell.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shell.screenshot({path:resolve(output,'jobs-page-mobile.png'),fullPage:true,animations:'disabled'});
   }else{
     await shell.getByRole('heading',{name:'Apply for jobs',exact:true}).waitFor();assert.equal(await shell.getByRole('button',{name:'Jobs',exact:true}).count(),0);assert.deepEqual(jobReads,[]);
   }
   await context.close();
 }
 assert.equal(errors.length,0);
 console.log('PASS: admin-only Jobs sidebar and deep-link guard, complete job metadata/matches, filters, pause/resume and mobile layout. Synthetic APIs only.');
}finally{await browser.close();await server.close();}
