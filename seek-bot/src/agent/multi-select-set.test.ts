import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'patchright';

const directory=mkdtempSync(join(tmpdir(),'owtomate-set-fixture-'));
Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',DRY_RUN:'true'});
let grounded=true,calls=0;
const original=globalThis.fetch;
globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({grounded,values:grounded?['Tuesday','Wednesday']:[],rationale:'Explicit fixture availability'})}}]});};
const {doChooseOptions,doAnswerQuestions}=await import('./tools/answers.js');
const {observe}=await import('./observe.js');
const {readSavedForm}=await import('./saved-form.js');
const {RunGuards}=await import('./guards.js');
const {CostMeter}=await import('./celeris.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
try{
 const page=await browser.newPage();
 await page.setContent(`<label for="days">Days available *</label><input id="days" role="combobox" aria-controls="days-list" aria-expanded="true" value="Monday, Tuesday"><div id="days-list" role="listbox" aria-multiselectable="true">${['Monday','Tuesday','Wednesday'].map((day,i)=>`<button type="button" role="option" aria-selected="${i<2}" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);this.setAttribute('aria-selected',this.getAttribute('aria-selected')!=='true')">${day}</button>`).join('')}</div><label for="guard">Unrelated country</label><input id="guard" value="Australia">`);
 const ctx={architecture:'compact',page,profile:{name:'Fixture',email:'fake@example.test',phone:'',skills:[],excludedDomains:[],experienceSummary:'Available Tuesday and Wednesday only'},
  job:{id:'set-fixture',title:'Developer',company:'Fixture',location:'Sydney',url:'https://recovery.fixture.invalid/set'},
  observation:await observe(page),guards:new RunGuards({maxSteps:30,maxStepsPerPage:16,maxStuckMs:60000,maxTotalMs:600000,meter:new CostMeter(1)}),captured:[],actions:[],log:()=>{}} as unknown as Parameters<typeof doChooseOptions>[0];
 const args=()=>{const a=ctx.observation.actions.find(a=>a.multiSelect)!;return {ref:a.ref,field_ref:a.fieldRef};};
 const result=await doAnswerQuestions(ctx,{refs:[String(args().field_ref)]});
 assert.match('message' in result?result.message:'',/Verified committed/);
 assert.deepEqual(await page.locator('[aria-selected=true]').allTextContents(),['Tuesday','Wednesday']);
 assert.equal(await page.locator('#guard').inputValue(),'Australia');
 assert.equal(await page.locator('body').getAttribute('data-clicks'),'2','only the symmetric difference is clicked');
 const before=calls;await doChooseOptions(ctx,args());
 assert.equal(calls,before,'the exact owner/job/evidence/options target is reused');
 assert.equal(await page.locator('body').getAttribute('data-clicks'),'2','already correct choices never toggle off');
 const form=await readSavedForm(page);
 const field=form.fields.find(f=>f.label.includes('Days available'))!;
 assert.deepEqual(field.selectedValues,['Tuesday','Wednesday'],'the independent saved-form read sees the same committed set');
 const wrong=await doChooseOptions(ctx,{...args(),field_ref:'unrelated'});
 assert.match('message' in wrong?wrong.message:'',/matching originating field/);
 assert.equal(calls,before);
 grounded=false;ctx.profile.experienceSummary='No verified availability';
 const unknown=await doChooseOptions(ctx,args());
 assert.match('message' in unknown?unknown.message:'',/No verified candidate evidence/);
 assert.deepEqual(await page.locator('[aria-selected=true]').allTextContents(),['Tuesday','Wednesday'],'missing facts do not change selections');
 console.log('PASS: exact multi-select set, idempotence, owner-field boundary, evidence invalidation and independent saved-state agreement');
}finally{globalThis.fetch=original;await browser.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-set-fixture-'));rmSync(directory,{recursive:true,force:true});}
