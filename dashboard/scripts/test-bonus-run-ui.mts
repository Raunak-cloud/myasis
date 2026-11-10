/** Actual React UI, dummy accounts, no production server or application writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {bonusRunPreviewServer} from './preview-bonus-run.mts';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const server=await bonusRunPreviewServer();
const origin=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{executablePath:'/usr/bin/google-chrome-stable'})});
const output=resolve(import.meta.dirname,'../../output/bonus-run-preview');mkdirSync(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1360,height:1100}});page.setDefaultTimeout(6000);
 const errors:string[]=[],requests:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){requests.push(url.href);return route.abort();}
  if(url.pathname.startsWith('/api/')){requests.push(route.request().method()+' '+url.pathname);return route.abort();}
  return route.continue();
 });
 await page.goto(origin);
 const admin=page.getByRole('complementary',{name:'Bonus run admin controls'}),customer=page.getByRole('region',{name:'Customer dashboard preview'});
 const states=page.getByRole('group',{name:'Bonus run preview states'});
 assert.doesNotMatch(await customer.innerText(),/20 remaining|2 of 2 used|Today’s regular runs|Credits used/);
 await admin.getByRole('checkbox').check();await admin.getByRole('button',{name:'Start bonus run',exact:true}).click();
 assert.match(await customer.innerText(),/Your bonus run is next/);assert.match(await customer.innerText(),/current run will finish first/);
 assert.equal(await admin.getByLabel('Customer',{exact:true}).isDisabled(),true);
 await states.getByRole('button',{name:'In progress',exact:true}).click();
 assert.match(await customer.innerText(),/Applying to your matches/);assert.match(await customer.innerText(),/Bonus run/);
 assert.doesNotMatch(await customer.innerText(),/20 remaining|2 of 2 used|Today’s regular runs|Credits used/);
 assert.doesNotMatch(await customer.innerText(),/MiniMax|Celeris|model|API|token|hash|Simulation only|Preview a run state/i);
 await page.screenshot({path:resolve(output,'admin-and-customer.png'),fullPage:true});
 await states.getByRole('button',{name:'Completed',exact:true}).click();
 assert.match(await customer.innerText(),/6 applications submitted/);assert.match(await customer.innerText(),/Complimentary/);
 await customer.getByRole('button',{name:'View applications',exact:true}).click();assert.equal(await customer.getByRole('region',{name:'Bonus applications'}).count(),1);
 assert.match(await customer.getByRole('region',{name:'Customer run history'}).innerText(),/Bonus run/);
 await page.screenshot({path:resolve(output,'completed.png'),fullPage:true});
 await states.getByRole('button',{name:'Needs attention',exact:true}).click();
 await customer.getByRole('button',{name:'Review question',exact:true}).click();
 assert.equal(await customer.getByRole('button',{name:'Save answer & continue'}).isDisabled(),true);
 await customer.getByRole('radio',{name:'Yes',exact:true}).check();await customer.getByRole('button',{name:'Save answer & continue'}).click();
 assert.match(await customer.innerText(),/Applying to your matches/);
 await customer.getByRole('button',{name:'Stop bonus run',exact:true}).click();
 const dialog=customer.getByRole('alertdialog',{name:'Stop bonus run?'});await dialog.getByRole('button',{name:'Keep running'}).click();assert.equal(await dialog.count(),0);
 await customer.getByRole('button',{name:'Stop bonus run',exact:true}).click();await customer.getByRole('button',{name:'Stop this run',exact:true}).click();
 assert.match(await customer.innerText(),/Your bonus run was stopped/);assert.match(await customer.innerText(),/won’t use any of your application credits or regular runs/);
 await admin.getByRole('button',{name:'Reset simulation'}).click();
 await admin.getByLabel('Application mode',{exact:true}).selectOption('semi-auto');
 await admin.getByLabel('Customer',{exact:true}).selectOption('1');
 await admin.getByLabel('Message shown to the customer (optional)',{exact:true}).fill('A bonus run, just for you.');
 await admin.getByLabel('Maximum applications',{exact:true}).fill('3');
 await admin.getByRole('button',{name:'Start bonus run',exact:true}).click();
 await states.getByRole('button',{name:'Completed',exact:true}).click();
 assert.match(await customer.innerText(),/3 applications are ready for your approval/);assert.doesNotMatch(await customer.innerText(),/0 remaining/);assert.match(await customer.innerText(),/won’t use any of your application credits or regular runs/);
 assert.match(await customer.innerText(),/A bonus run, just for you/);assert.doesNotMatch(await customer.innerText(),/3 applications submitted/);
 await customer.getByRole('button',{name:'Review prepared applications'}).click();assert.match(await customer.innerText(),/No application credits will be used/);
 await page.getByRole('button',{name:'Phone',exact:true}).click();await page.screenshot({path:resolve(output,'phone-in-admin.png'),fullPage:true});
 await page.getByRole('button',{name:'Switch theme'}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 await page.screenshot({path:resolve(output,'dark-theme.png'),fullPage:true});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`no horizontal overflow at ${width}px`);
 }
 await page.setViewportSize({width:390,height:1000});await customer.screenshot({path:resolve(output,'customer-phone.png')});
 await admin.getByRole('button',{name:'Reset simulation'}).click();
 await admin.getByRole('checkbox').check();await admin.getByRole('button',{name:'Start bonus run',exact:true}).click();
 await customer.getByRole('button',{name:'Stop bonus run',exact:true}).click();await customer.getByRole('button',{name:'Stop this run',exact:true}).click();
 assert.match(await customer.innerText(),/No applications were prepared/);
 await admin.getByRole('button',{name:'Reset simulation'}).click();await admin.getByLabel('Maximum applications',{exact:true}).fill('1');
 await states.getByRole('button',{name:'Completed',exact:true}).click();assert.match(await customer.innerText(),/1 application is ready/);
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'no account, credit, run, email or external API requests');
 console.log('PASS: bonus admin/customer simulation, queue, start, progress, completion, history, stop confirmation, personal answer, free Semi-auto, zero-credit user, frozen settings, mobile, dark theme and zero API requests.');
 console.log('Screenshots: '+output);
}finally{await browser.close();await server.close();}
