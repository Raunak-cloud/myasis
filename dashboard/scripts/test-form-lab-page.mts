import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {formsPage} from '../server/form-lab/page.js';
const html=formsPage();for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
const {chromium}=createRequire(new URL('../../seek-bot/package.json',import.meta.url))('patchright');
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
const deadline=setTimeout(()=>{console.error('Form page check exceeded one minute');process.exit(1);},55000);deadline.unref();
let starts=0;const errors:string[]=[];
try{
 const context=await browser.newContext({viewport:{width:1400,height:900}}),page=await context.newPage();page.on('pageerror',(error:Error)=>errors.push(error.message));
 await context.route('**/*',async(route:any)=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/forms')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/api/admin/forms'){
   if(request.method()==='POST'){starts++;const posted=JSON.parse(request.postData());assert.equal(posted.confirm,true);return route.fulfill({json:{id:'fixture',url:'/forms/fixture'}});}
   return route.fulfill({json:{forms:[{key:'enterprise',name:'Enterprise application',description:'Repeated fields and delayed selections.',account:false},{key:'account',name:'Candidate account and Gmail',description:'Account creation and code verification.',account:true},{key:'embedded',name:'Embedded employer portal',description:'Nested questions and supporting evidence.',account:false}],attempts:[],gmailConnected:true,mailbox:'fixture@example.invalid'}});
  }
  return route.abort();
 });
 await page.goto('http://fixture.invalid/forms');await page.getByRole('heading',{name:'Enterprise application',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Run agent',exact:true}).count(),3);
 await page.getByRole('button',{name:'Run agent',exact:true}).first().click();assert.equal(await page.getByRole('dialog').isVisible(),true);assert.equal(starts,0);await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(starts,0);
 await page.getByRole('button',{name:'Run agent',exact:true}).first().click();await page.getByRole('button',{name:'Start test',exact:true}).click();await page.getByRole('status').filter({hasText:'Test started.'}).waitFor();assert.equal(starts,1);
 const dir=resolve(import.meta.dirname,'../../output/form-lab-ui');mkdirSync(dir,{recursive:true});await page.screenshot({path:resolve(dir,'admin-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:resolve(dir,'admin-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS admin form page: three cards, desktop/mobile, explicit start/cancel, mocked API only. No real agent run or email.');
}finally{clearTimeout(deadline);await browser.close();}
