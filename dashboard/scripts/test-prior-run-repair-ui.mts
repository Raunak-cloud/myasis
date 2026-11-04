/** Real admin simulation components, fictional APIs, zero run/application writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const html='<!doctype html><html><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{SimulateView}from"/src/components/SimulateView.tsx";import"/src/index.css";createRoot(document.getElementById("root")).render(React.createElement(SimulateView));</script></body></html>';
const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'repair-preview-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url!=='/repair-preview.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,html));
});}}],server:{host:'127.0.0.1',port:0},logLevel:'error'});
await vite.listen();const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{executablePath:'/usr/bin/google-chrome-stable'})});
try{
 const page=await browser.newPage({viewport:{width:1050,height:950}});let writes=0;
 await page.route('**/api/**',route=>{if(route.request().method()!=='GET')writes++;return route.fulfill({contentType:'application/json',body:JSON.stringify({simulations:[]})});});
 await page.goto(origin+'/repair-preview.html');const preview=page.getByRole('region',{name:'Prior-run recovery simulation'});
 await preview.getByRole('button',{name:'Start simulated recovery'}).click();
 assert.match(await preview.innerText(),/Owtobot found a few issues in your prior runs and is fixing them/);
 assert.match(await preview.innerText(),/Retrying 3 previously approved applications/);
 const output=process.env.REPAIR_PREVIEW_SCREENSHOT;
 if(output){mkdirSync(resolve(output,'..'),{recursive:true});await preview.screenshot({path:output});}
 await preview.getByRole('button',{name:'Confirmed submissions',exact:true}).click();
 assert.match(await preview.innerText(),/employer confirmation received/);assert.doesNotMatch(await preview.innerText(),/is fixing them/);
 await preview.getByRole('button',{name:'Needs attention',exact:true}).click();
 assert.match(await preview.innerText(),/needs the candidate/);assert.doesNotMatch(await preview.innerText(),/employer confirmation received/);
 await page.setViewportSize({width:375,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.equal(writes,0);await browser.close();console.log('PASS: actual admin recovery simulation, active/completed/attention copy, mobile layout and zero application writes.');
}finally{await browser.close();await vite.close();}
