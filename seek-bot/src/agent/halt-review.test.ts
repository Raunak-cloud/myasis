import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { ToolContext } from './context.js';
import type { CelerisRequest } from './celeris.js';

const dir=mkdtempSync(join(tmpdir(),'halt-review-'));
process.env.DATA_DIR=dir;process.env.COST_TRACKING='false';
mkdirSync(join(dir,'resumes'));writeFileSync(join(dir,'resumes','Fixture CV.txt'),'Fictional TypeScript developer.');
writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'cv',fileName:'Fixture CV.txt',label:'Fixture CV'}]));
const {reviewHalt,newHaltReviewState}=await import('./halt-review.js');
const {CostMeter}=await import('./celeris.js');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
try{
 const page=await browser.newPage();
 await page.setContent('<label>Notice period<input id=notice required></label><label>Australian work rights<input required></label><label>Resume<input id=cv type=file></label><label>Password<input type=password value="fixture-secret"></label>');
 await page.locator('#cv').setInputFiles({name:'Fixture CV.txt',mimeType:'text/plain',buffer:Buffer.from('Fictional TypeScript developer.')});
 const ctx={page,job:{id:'fixture',title:'Developer',company:'Fictional employer',url:'https://fixture.invalid/apply'},profile:{name:'Alex Fixture',skills:[],noticePeriod:'2 weeks',workRights:'Australian citizen'},
  captured:[],actions:[],observation:{fields:[],actions:[],url:page.url(),title:'Fixture',text:''},log:()=>{}} as unknown as ToolContext;
 const state=newHaltReviewState(),meter=new CostMeter(.20);let requests=0;
 const responder=async(request:CelerisRequest)=>{
  requests++;assert.equal(request.meter,meter);assert.equal(request.tools,undefined);
  const body=JSON.stringify(request.messages);assert.match(body,/Australian citizen|2 weeks/);assert.doesNotMatch(body,/fixture-secret/);
  meter.recordProvider({prompt:10,cached:0,completion:10,amountUsd:.01});
  return {text:JSON.stringify({decision:'continue',reason:'The authoritative profile supplies the missing notice.',evidence:[{source:'profile',quote:'2 weeks'}]}),toolCalls:[],message:{role:'assistant' as const,content:null}};
 };
 const proposal={status:'needs-human',reason:'Notice period unavailable',questions:[{field_ref:'f0'}]};
 assert.equal((await reviewHalt(ctx,proposal,state,meter,responder)).decision,'continue');
 assert.equal((await reviewHalt(ctx,proposal,state,meter,responder)).decision,'continue');assert.equal(requests,1,'unchanged evidence reuses the bounded review');
 await page.locator('#notice').fill('2 weeks');
 assert.equal((await reviewHalt(ctx,{status:'skipped',reason:'Resume unavailable'},state,meter,responder)).decision,'continue');
 assert.equal(requests,2);assert.equal(meter.totals.costUsd,.02);
 assert.equal((await reviewHalt(ctx,{status:'skipped',reason:'Another blocker'},state,meter,responder)).decision,'unavailable');assert.equal(requests,2);
 assert.equal(await page.locator('#notice').inputValue(),'2 weeks','review does not alter candidate answers');
 const unknown=await reviewHalt(ctx,{status:'needs-human',reason:'Exact visa expiry is unknown'},newHaltReviewState(),meter,async()=>
  ({text:JSON.stringify({decision:'stop',reason:'No explicit expiry date is supplied; do not infer it.',evidence:[]}),toolCalls:[],message:{role:'assistant',content:null}}));
 assert.equal(unknown.decision,'stop','genuine unknown facts still reach the candidate');
 const fabricated=await reviewHalt(ctx,proposal,newHaltReviewState(),meter,async()=>({text:JSON.stringify({decision:'continue',reason:'Use an invented date.',evidence:[{source:'profile',quote:'31 December 2030'}]}),toolCalls:[],message:{role:'assistant',content:null}}));
 assert.equal(fabricated.decision,'unavailable','unsupported review claims never authorize work');
 ctx.submissionAttempted=true;
 assert.equal((await reviewHalt(ctx,proposal,newHaltReviewState(),meter,async()=>{throw Error('No request permitted after a possible send');})).decision,'unavailable');
 console.log('PASS: fresh stopping reviews ground known facts, preserve unknowns and credentials, share the original budget, cache unchanged evidence and never act after a send.');
}finally{await browser.close();rmSync(dir,{recursive:true,force:true});}
