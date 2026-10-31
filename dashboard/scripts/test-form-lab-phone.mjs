import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {FormLab,formCatalog,pagesFor} from '../server/form-lab/engine.mjs';
import {callingCodeOptions} from '../server/form-lab/calling-codes.mjs';
assert.equal(callingCodeOptions.length,50);assert.equal(new Set(callingCodeOptions).size,50);assert.ok(callingCodeOptions.includes('Australia (+61)'));
for(const form of formCatalog){const pages=pagesFor(form.key,'fixture@example.invalid');for(const name of ['dial','refDial']){const field=pages.flatMap(page=>page.groups.flatMap(group=>group.fields)).find(field=>field.name===name);assert.deepEqual(field.options,callingCodeOptions);assert.equal(field.dropdown,true);assert.equal(field.row,'phone');}}
const lab=new FormLab({key:'enterprise',email:'fixture@example.invalid',seed:21,id:'33333333-3333-4333-8333-333333333333',secret:'phone-ui-fixture'});
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://fixture.invalid');const chunks=[];for await(const chunk of req)chunks.push(chunk);const response=await lab.request({method:req.method,path:url.pathname.slice(lab.base.length),body:Buffer.concat(chunks),contentType:req.headers['content-type']},async()=>{throw Error('No email expected.');});res.writeHead(response.status,response.headers);res.end(response.body);}catch(error){res.writeHead(500);res.end(error.message);}});
const {chromium}=createRequire(new URL('../../seek-bot/package.json',import.meta.url))('patchright');let browser;
const deadline=setTimeout(()=>{console.error('Phone control check exceeded one minute');process.exit(1);},55000);deadline.unref();
try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'})});
 const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port+lab.base+'/page/1');
 const country=page.getByRole('combobox',{name:'Phone country code',exact:false}),mobile=page.getByLabel('Mobile number',{exact:false}),menu=page.getByRole('listbox',{name:'Phone country code suggestions',exact:true});
 await mobile.fill('412345678');await country.click();await page.waitForFunction(()=>document.querySelectorAll('#menu-dial [role=option]').length===50);assert.equal(await menu.getByRole('option').count(),50);
 await country.fill('Nepal');await menu.getByRole('option',{name:'Nepal (+977)',exact:true}).click();assert.equal(await page.locator('[name=dial]').inputValue(),'Nepal (+977)');assert.equal(await mobile.inputValue(),'412345678');
 await country.fill('+61');assert.equal(await page.locator('[name=dial]').inputValue(),'','typing alone does not commit a country');await menu.getByRole('option',{name:'Australia (+61)',exact:true}).waitFor();await country.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.locator('[name=dial]').inputValue(),'Australia (+61)');
 const dir=resolve(import.meta.dirname,'../../output/form-lab-phone');mkdirSync(dir,{recursive:true});
 for(const [width,name]of [[1280,'desktop'],[390,'mobile']]){
  await page.setViewportSize({width,height:960});const a=await page.locator('.phone-row .combo-entry').boundingBox(),b=await mobile.boundingBox();assert.ok(Math.abs(a.y-b.y)<2,'phone controls share the same row');assert.ok(a.x+a.width<=b.x,'country selector sits beside the number');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('button',{name:'Show phone country code options',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#menu-dial [role=option]').length===50);assert.equal(await page.locator('[name=dial]').inputValue(),'Australia (+61)','opening the list preserves the current choice');await page.screenshot({path:resolve(dir,name+'.png'),fullPage:true});await country.press('Escape');assert.equal(await country.getAttribute('aria-expanded'),'false');
 }
 await page.getByLabel('Full name',{exact:false}).fill('Alex Morgan');await page.getByLabel('Email',{exact:false}).fill(lab.email);await page.locator('#continue').click();await page.waitForURL('**/page/2');assert.equal(lab.state.saved[1].values.dial,'Australia (+61)');assert.equal(lab.state.saved[1].values.mobile,'412345678');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,countries:50,allForms:true,desktop:true,mobile:true,searchByCountry:true,searchByCode:true,keyboardSelection:true,savedValuesVerified:true,modelCalls:0,emails:0}));
}finally{clearTimeout(deadline);await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
