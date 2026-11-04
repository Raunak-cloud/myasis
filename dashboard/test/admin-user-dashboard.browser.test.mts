import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync } from 'node:fs';
import { sealQuestionSnapshot } from '../../seek-bot/src/question-snapshot-node';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const built=await build({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react()],define:{'process.env.NODE_ENV':'"production"'},logLevel:'error',build:{write:false,lib:{entry:resolve(import.meta.dirname,'admin-user-dashboard.fixture.tsx'),formats:['iife'],name:'Fixture'}}});
const assets=(Array.isArray(built)?built:[built]).flatMap(result=>'output' in result?result.output:[]);
const js=assets.find(asset=>asset.type==='chunk');assert.ok(js&&js.type==='chunk');
const css=assets.filter(asset=>asset.type==='asset').map(asset=>asset.type==='asset'?String(asset.source):'').join('\n');
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?js.code:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  const writes:Array<{url:string;body:unknown}>=[];let fail=false;let removed=false;
  const birth=sealQuestionSnapshot({version:2,source:{origin:'https://employer.example',path:'/register'},prompt:'Date of birth',context:[],help:[],completeness:'complete',controls:[{id:'part0',label:'Date of birth',kind:'text',required:true,multiple:false,choices:[],constraints:{}}]});
  let releaseOld:()=>void;const oldHeld=new Promise<void>(done=>{releaseOld=done;});
  const pendingOld:Promise<void>[]=[];
  await page.route('**/api/**',async route=>{
    const req=route.request();const path=new URL(req.url()).pathname;
    assert.ok(path.startsWith('/api/admin/users/'),'no ordinary user/session endpoint is called');
    if(req.method()==='DELETE'){
      writes.push({url:path,body:req.postDataJSON()});
      assert.equal(path,'/api/admin/users/22/attention');
      if(!fail)removed=true;
      return route.fulfill({status:fail?409:200,json:fail?{error:'INTERNAL_SECRET'}:{ok:true}});
    }
    const id=path.split('/')[4];
    if(id==='11'){const wait=oldHeld.then(()=>{});pendingOld.push(wait);await wait;}
    await route.fulfill({json:{userId:id,email:`user${id}@example.test`,attention:removed?[]:[{jobId:'same-job',removalRevision:id.repeat(32),title:`Role ${id}`,company:'Employer',at:new Date().toISOString(),url:'https://example.test/job',kind:'question',reason:'INTERNAL_SECRET',needsQuestionCapture:false,questions:[{question:birth.prompt,snapshot:birth}]}],applications:[{id:'draft',status:'ready',application:{job:{title:'Prepared role',company:'Employer',location:'Sydney',url:'https://example.test/job'},answers:[{question:'Availability',answer:'Two weeks'}],coverLetter:'Approved letter'}}]}});
  });
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Switch account'}).click();
  await page.getByText('Role 22',{exact:true}).waitFor();
  releaseOld!();await Promise.all(pendingOld);
  assert.equal(await page.getByText('Role 11',{exact:true}).count(),0,'late prior-owner response cannot replace the current account');
  await page.getByText('View employer questions',{exact:true}).click();
  assert.equal(await page.getByLabel('Date of birth',{exact:true}).getAttribute('type'),'date');
  assert.ok(await page.getByLabel('Date of birth',{exact:true}).isDisabled(),'support view cannot invent or save personal answers');
  assert.equal(await page.getByRole('button',{name:'Save answers',exact:true}).count(),0);
  const remove=page.getByRole('button',{name:'Remove Role 22 from Needs attention'});
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();assert.equal(writes.length,0,'cancel makes no mutation');
  fail=true;page.once('dialog',dialog=>{assert.ok(dialog.message().includes('user22@example.test'));return dialog.accept();});await remove.click();
  await page.getByRole('alert').waitFor();assert.equal(await remove.count(),1,'conflict retains the row');
  assert.ok(!(await page.locator('body').innerText()).includes('INTERNAL_SECRET'));
  assert.deepEqual(writes[0].body,{jobId:'same-job',revision:'22'.repeat(32)});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await page.getByRole('button',{name:'Refresh dashboard',exact:true}).waitFor();
  await page.locator('summary').filter({hasText:'Prepared role'}).click();await page.getByText('Approved letter',{exact:true}).waitFor();
  mkdirSync(resolve(import.meta.dirname,'../../output/admin-user-dashboard-review'),{recursive:true});
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(import.meta.dirname,`../../output/admin-user-dashboard-review/${width}.png`),fullPage:true});}
  fail=false;page.once('dialog',dialog=>dialog.accept());await remove.click();await page.getByText('No questions waiting.',{exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-changed'),'yes');
  assert.equal(writes.length,2);console.log('PASS explicit account, late response, cancel, stale conflict, no technical copy, prepared readback, mobile/desktop and exact removal');
} finally {await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
