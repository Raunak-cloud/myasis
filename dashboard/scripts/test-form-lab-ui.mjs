import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {FormLab,formCatalog} from '../server/form-lab/engine.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const {chromium}=createRequire(new URL('../../seek-bot/package.json',import.meta.url))('patchright');
const started=Date.now(),outbox=new Map(),labs=formCatalog.map((form,index)=>new FormLab({key:form.key,email:'fixture@example.invalid',seed:21,id:'11111111-1111-4111-8111-'+String(index+1).padStart(12,'0'),secret:'synthetic-ui-only'}));
let browser;
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://fixture.invalid'),lab=labs.find(lab=>url.pathname.startsWith(lab.base+'/'));if(!lab){res.writeHead(404);res.end();return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=await lab.request({method:req.method,path:url.pathname.slice(lab.base.length),query:url.search,body:Buffer.concat(chunks),contentType:req.headers['content-type']},async message=>{outbox.set(lab.id,message);});res.writeHead(result.status,result.headers);res.end(result.body);}catch(error){res.writeHead(500);res.end(error.message);}});
const deadline=setTimeout(()=>{console.error('Form UI check exceeded 60 seconds');process.exit(1);},58000);deadline.unref();
try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'}),args:['--disable-dev-shm-usage']});
 await Promise.all(labs.map(async lab=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(4500);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+lab.base+'/page/1');
  const login=async()=>{await page.locator('[name=email]').fill(lab.email);await page.locator('[name=password]').fill('Synthetic-password-123');if(await page.locator('[name=name]').count()){await page.locator('[name=name]').fill('Alex Morgan');await page.locator('[name=confirm]').fill('Synthetic-password-123');}await page.getByRole('button').click();await page.waitForURL('**/verify');const code=outbox.get(lab.id).text.match(/code is: (\d{6})/)[1];for(const [i,digit]of [...code].entries())await page.locator('[name=digit'+(i+1)+']').fill(digit);await page.getByRole('button').click();await page.waitForURL('**/page/*');};
  if(lab.definition.account)await login();
  for(const [index,spec]of lab.pages.entries()){
   if(lab.definition.account&&index===2){await page.waitForURL('**/register');await login();}
   await page.waitForURL('**/page/'+(index+1));
   let scope=spec.frame?page.frameLocator('iframe[title="Compliance service"]'):page;if(spec.nested)scope=scope.frameLocator('iframe[title="Inner employer questions"]');
   await scope.locator('#loading').waitFor({state:'hidden'});if(spec.addRows)await scope.locator('#add').click();await scope.locator('form').waitFor({state:'visible'});
   for(const field of spec.groups.flatMap(group=>group.fields)){
    const expected=spec.expected[field.name],target=scope.locator('[name="'+field.name+'"]');
    if(field.kind==='file'){const ids=spec.uploads[field.name];await target.setInputFiles(ids.map(id=>({name:lab.materials.files[id].name,mimeType:id==='cv'||id==='qualification'?'application/pdf':'text/plain',buffer:lab.materials.files[id].bytes})));await scope.locator('[data-upload="'+field.name+'"]').filter({hasText:'- ready'}).waitFor();continue;}
    if(field.kind==='editor'){const rule=spec.textChecks[field.name];await scope.locator('[data-editor="'+field.name+'"]').fill((rule.words.join(' ')+' fictional application evidence. ').repeat(8));continue;}
    if(expected===''||expected==null)continue;
    if(field.kind==='checkbox'){await target.check();continue;}
    if(field.kind==='shadow'){await scope.locator('hard-consent[data-name="'+field.name+'"]').locator('input').check();continue;}
    if(field.kind==='radio'){await scope.locator('[name="'+field.name+'"][value="'+expected+'"]').check();continue;}
    if(field.kind==='multi'){for(const value of expected)await scope.locator('[name="'+field.name+'"][value="'+value+'"]').check();continue;}
    if(field.kind==='combo'){await scope.locator('[name="'+field.name+'Text"]').fill(expected);await scope.getByRole('option',{name:expected,exact:true}).click();continue;}
    if(field.kind==='select'||field.kind==='dependent'){await target.selectOption({label:expected});continue;}
    if(!field.copy)await target.fill(expected);
   }
   await scope.locator('#continue').click();
   if(spec.transient){await scope.getByRole('alert').filter({hasText:'Temporary service interruption'}).waitFor();await scope.locator('#continue').click();}
   if(spec.review){await page.getByRole('alert').filter({hasText:'additional fictional processing consent'}).waitFor();await page.reload();await page.locator('[name=accuracy]').check();await page.locator('[name=processing]').check();await page.locator('#continue').click();}
   if(spec.frame){await page.getByText('Compliance saved.',{exact:true}).waitFor();await page.locator('#frame-next').click();}
  }
  await page.waitForURL('**/receipt');assert.match(await page.locator('body').innerText(),/Application submitted successfully/);assert.equal(lab.summary().pagesCompleted,15);assert.equal(lab.summary().recoveredServiceFailures,3);if(lab.definition.account)assert.equal(lab.summary().verificationCodesAccepted,2);assert.deepEqual(errors,[]);
  const output=resolve(import.meta.dirname,'../../output/form-lab-ui');mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,lab.key+'.png'),fullPage:true});await context.close();
 }));
 console.log(JSON.stringify({passed:true,forms:labs.map(lab=>({key:lab.key,pages:lab.summary().pagesCompleted,checks:lab.summary().checksPassed,codes:lab.summary().verificationCodesAccepted})),elapsedMs:Date.now()-started,modelCalls:0,realEmails:0}));
}finally{clearTimeout(deadline);await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
