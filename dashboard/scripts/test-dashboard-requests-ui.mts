/** Real React hooks and sign-in polling. All APIs and accounts are fictional. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const root=resolve(import.meta.dirname,'..');
const counts=new Map<string,number>();let owner='owner-a',signedIn=false;
async function waitUntil(test:()=>boolean){const deadline=Date.now()+8000;while(!test()){assert(Date.now()<deadline,'Fixture polling did not reach its expected request count');await new Promise(done=>setTimeout(done,20));}}
const html=`<!doctype html><html><body><div id="root"></div><script type="module">
import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';
import{useBillingStatus}from'/src/billing.ts';import{useBoardsStatus,BOARDS_CHANGED}from'/src/boards.ts';
import{useEntitlements}from'/src/entitlements.ts';import{useSetupStatus}from'/src/setupStatus.ts';
import{SeekSignIn}from'/src/components/SeekSignIn.tsx';import{setDashboardAccount}from'/src/dashboard-requests.ts';
const interval=window.setInterval.bind(window);window.setInterval=(fn,ms,...args)=>interval(fn,ms===4000?20:ms,...args);
setDashboardAccount('owner-a');
function Consumer({id}){const billing=useBillingStatus(),boards=useBoardsStatus(),ent=useEntitlements(),setup=useSetupStatus();return React.createElement('output',{'data-testid':'consumer-'+id},JSON.stringify({owner:billing?.owner,credit:billing?.totalRemaining,connected:boards?.seek?.signedIn,account:boards?.seek?.account,tier:ent?.tier,ready:setup?.ready}));}
function Harness(){return React.createElement(React.Fragment,null,
 React.createElement('button',{onClick:()=>window.dispatchEvent(new Event(BOARDS_CHANGED))},'Refresh connections'),
 React.createElement('button',{onClick:async()=>{await fetch('/control?owner=owner-b');setDashboardAccount('owner-b');}},'Switch account'),
 ...[1,2,3].map(id=>React.createElement(Consumer,{id,key:id})),React.createElement(SeekSignIn,{showConnected:true}));}
createRoot(document.getElementById('root')).render(React.createElement(StrictMode,null,React.createElement(Harness)));
</script></body></html>`;
const server=await createServer({configFile:false,root,plugins:[react(),{name:'shared-dashboard-fixture',configureServer(app){app.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url!,'http://fixture');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(await app.transformIndexHtml('/',html));return;}
 if(url.pathname==='/control'){owner=url.searchParams.get('owner')??owner;if(url.searchParams.has('signedIn'))signedIn=url.searchParams.get('signedIn')==='true';res.end('{}');return;}
 if(!url.pathname.startsWith('/api/'))return next();
 assert.equal(req.method,'GET','fixture must never start a run, send email or alter customer settings');
 const path=url.pathname;counts.set(path,(counts.get(path)??0)+1);
 const payloads:Record<string,unknown>={
  '/api/billing/status':{owner,totalRemaining:owner==='owner-a'?5:11},
  '/api/entitlements':{tier:owner==='owner-a'?'intensive':'standard'},
  '/api/setup/status':{checks:[],ready:true},
  '/api/signin/session':{supported:false,session:null,checking:true,seek:{signedIn,account:owner,checkedAt:new Date().toISOString()}},
 };
 const body=JSON.stringify(payloads[path]??{});await new Promise(done=>setTimeout(done,30));res.setHeader('Content-Type','application/json');res.end(body);
 });}}],server:{host:'127.0.0.1',port:0,fs:{allow:[resolve(root,'..')]}},logLevel:'error'});
await server.listen();const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
try{
 const page=await browser.newPage();page.setDefaultTimeout(8000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);
 await page.waitForFunction(()=>[...document.querySelectorAll('output')].length===3&&[...document.querySelectorAll('output')].every(e=>e.textContent?.includes('"credit":5')&&e.textContent.includes('"ready":true')));
 for(const path of ['/api/billing/status','/api/entitlements','/api/setup/status'])assert.equal(counts.get(path),1,`${path}: three consumers, one initial GET`);
 await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('"connected":false'));
 await waitUntil(()=>(counts.get('/api/signin/session')??0)>=35);
 assert.equal(counts.get('/api/billing/status'),1,'unchanged sign-in polling must not trigger billing requests');
 assert.equal(counts.get('/api/entitlements'),1,'timestamps alone do not announce connection changes');
 await page.getByRole('button',{name:'Refresh connections',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('"credit":5'));
 await waitUntil(()=>(counts.get('/api/billing/status')??0)>=2);
 await new Promise(done=>setTimeout(done,100));assert.equal(counts.get('/api/billing/status'),2,'one refresh event produces one GET across all subscribers');
 signedIn=true;
 await page.waitForFunction(()=>[...document.querySelectorAll('output')].every(e=>e.textContent?.includes('"connected":true')));
 assert.equal(counts.get('/api/billing/status'),3,'a genuine connection change refreshes the allowance once');
 await page.getByRole('button',{name:'Switch account',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('output')].every(e=>e.textContent?.includes('"owner":"owner-b"')&&e.textContent.includes('"credit":11')&&e.textContent.includes('"tier":"standard"')));
 assert.deepEqual(errors,[]);
 console.log('PASS: real StrictMode hooks share initial and event reads, 35+ unchanged sign-in polls do not refresh billing, genuine connection changes refresh once, and account switches discard previous data. Fixture APIs only.');
}finally{await browser.close();await server.close();}
