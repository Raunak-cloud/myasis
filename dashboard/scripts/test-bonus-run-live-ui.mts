import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const html=`<html><body><div id="root"></div><script type="module">import React from 'react';import{createRoot}from'react-dom/client';import{AdminBonusRun}from'/src/components/AdminBonusRun.tsx';import{BonusRunNotice}from'/src/components/BonusRunNotice.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(AdminBonusRun,{userId:'183',mode:'auto'}),React.createElement(BonusRunNotice)));</script></body></html>`;
const server=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'bonus-live-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/fixture')return next();res.setHeader('content-type','text/html');res.end(await vite.transformIndexHtml('/fixture',html));});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{executablePath:'/usr/bin/google-chrome-stable'})});
try{
 const page=await browser.newPage(),writes:Array<{path:string;body:any}>=[],errors:string[]=[];let runs:any[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()==='POST'){const body=request.postDataJSON();writes.push({path:url.pathname,body});if(url.pathname==='/api/admin/users/183/bonus-run')runs=[{id:body.requestId,...body.options,status:'queued',createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,runId:null,applied:0,prepared:0}];else if(url.pathname==='/api/bonus-runs')runs=runs.map(r=>({...r,status:'stopped'}));}
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,runs})});});
 await page.goto(origin+'/fixture');const admin=page.getByRole('region',{name:'Admin bonus run'});
 await admin.getByLabel('Minimum salary reduction for this run only (%)').fill('10');await admin.getByRole('button',{name:'Start bonus run'}).click();
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/admin/users/183/bonus-run');assert.equal(writes[0].body.options.maxApplications,10);assert.equal(writes[0].body.options.salaryDiscountPercent,10);assert.deepEqual(Object.keys(writes[0].body.options).sort(),['applicationMode','maxApplications','message','salaryDiscountPercent']);
 await page.waitForTimeout(5200);const customer=page.getByRole('region',{name:'Your bonus run'});assert.match(await customer.innerText(),/Bonus run/);assert.match(await customer.innerText(),/won’t use any of your application credits or regular runs/);assert.doesNotMatch(await customer.innerText(),/140000|126000|2 of 2 used|credits remaining/i);
 await customer.getByRole('button',{name:'Stop bonus run'}).click();await customer.getByRole('button',{name:'Keep running'}).click();assert.equal(writes.length,1);
 await customer.getByRole('button',{name:'Stop bonus run'}).click();await customer.getByRole('button',{name:'Stop this run'}).click();assert.equal(writes.length,2);assert.equal(writes[1].body.action,'cancel');assert.deepEqual(errors,[]);
 console.log('PASS: real admin and customer bonus controls, targeted request, salary exception, complimentary copy and stop confirmation with fixture APIs only.');
}finally{await browser.close();await server.close();}
