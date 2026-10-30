import assert from 'node:assert/strict';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
const {chromium} = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const deadline = setTimeout(() => { console.error('Email-dialog check exceeded 45 seconds.'); process.exit(1); }, 45_000);
deadline.unref();
let rewrites = 0, sends = 0, holdRewrite = false;
let pending: ServerResponse | undefined;
const vite = await createViteServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],server:{middlewareMode:true},appType:'custom'});
const html = `<!doctype html><html><head></head><body><div id="root"></div><script type="module">
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{AdminEmailDialog}from'/src/components/AdminEmailDialog.tsx';import'/src/index.css';
function Fixture(){const[open,setOpen]=useState(false);return React.createElement(React.Fragment,null,
React.createElement('button',{onClick:()=>setOpen(true)},'Open email'),
open&&React.createElement(AdminEmailDialog,{key:'fixture',userId:'fixture',onClose:()=>setOpen(false),onSent:()=>{}}));}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));
</script></body></html>`;
const server = createHttpServer(async(req,res)=>{
 const path = new URL(req.url!,'http://fixture').pathname;
 if(path.startsWith('/api/')){
  for await (const _chunk of req) { /* Consume fixture-only request data. */ }
  res.setHeader('Content-Type','application/json');
  if(path.endsWith('/email-draft')){rewrites++;if(holdRewrite){pending=res;return;}res.end(JSON.stringify({subject:'Requested rewrite',body:'Manually requested Magnus version.'}));return;}
  if(path.endsWith('/email-history')){res.end(JSON.stringify({items:[],nextCursor:null}));return;}
  if(path.endsWith('/email')&&req.method==='POST'){sends++;res.end(JSON.stringify({ok:true}));return;}
  if(path.endsWith('/email')){res.end(JSON.stringify({to:'fixture@example.test',replyTo:'support@example.test',subject:'Standard subject',body:'Standard draft. No AI called.',missing:[],optedOut:false,canSend:true,lastSent:null}));return;}
  res.statusCode=404;res.end('{}');return;
 }
 if(path==='/'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/',html));return;}
 vite.middlewares(req,res,()=>{res.statusCode=404;res.end();});
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try{
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 page.setDefaultTimeout(5000);
 const errors:string[]=[];page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE ERROR:',error.message);});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin,{waitUntil:'domcontentloaded'});
 const open=page.getByRole('button',{name:'Open email',exact:true});
 await open.click();
 const dialog=page.getByRole('dialog');
 await page.getByLabel('Subject',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Subject',{exact:true}).inputValue(),'Standard subject');
 assert.equal(rewrites,0,'opening must never call Magnus');
 const focus=page.getByPlaceholder('Tell Magnus what to focus on',{exact:false});
 await focus.fill('Make it short');await focus.press('Enter');
 await page.locator('.overlay').click({position:{x:2,y:2}});await page.keyboard.press('Escape');
 assert.equal(await dialog.isVisible(),true,'outside click and Escape must preserve the composer');
 assert.equal(rewrites,0,'typing Enter must not request a rewrite');
 await page.getByRole('button',{name:'Rewrite with Magnus',exact:true}).click();
 await page.getByLabel('Subject',{exact:true}).filter({visible:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('label input')?.value==='Requested rewrite');
 assert.equal(rewrites,1,'one explicit button action should make one rewrite');
 holdRewrite=true;
 await page.getByRole('button',{name:'Rewrite with Magnus',exact:true}).click();
 await page.getByRole('button',{name:'Writing…',exact:true}).waitFor();
 await page.locator('textarea.admin-email-body').fill('My newer edit must survive.');
 assert.ok(pending,'fixture rewrite request should be waiting');
 pending.end(JSON.stringify({subject:'Delayed AI subject',body:'Delayed AI body'}));pending=undefined;
 await page.getByRole('button',{name:'Keep mine',exact:true}).waitFor();
 assert.equal(await page.locator('textarea.admin-email-body').inputValue(),'My newer edit must survive.');
 await page.getByRole('button',{name:'Keep mine',exact:true}).click();
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.getByRole('button',{name:'Sent',exact:true}).waitFor();
 assert.equal(sends,1);assert.equal(await dialog.isVisible(),true,'successful send must stay open until Close');
 assert.equal(await page.getByRole('button',{name:'Sent',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 assert.equal(await dialog.count(),0);
 await open.click();await page.getByLabel('Subject',{exact:true}).waitFor();
 assert.equal(rewrites,2,'reopening must not request another rewrite');
 assert.equal(await page.getByLabel('Subject',{exact:true}).inputValue(),'Standard subject');
 assert.deepEqual(errors,[]);
 console.log('PASS: no automatic rewrite on open/reopen/Enter; explicit rewrite only; pending edits retained; outside/Escape ignored; sent state stays open and blocks repeats; Close works. Fixture APIs only: no model calls or real emails.');
}finally{pending?.destroy();await browser?.close();await vite.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));clearTimeout(deadline);}
