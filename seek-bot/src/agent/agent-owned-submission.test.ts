import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'patchright';
import {specialistFixtureReply} from './specialist-fixture.js';
import {closeCelerisQueues} from '../../../shared/celeris-queue.mjs';

test('approved retry can navigate, script, coordinate-click, accept a dialog and send once without a forced review', {timeout:60000}, async()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-owned-send-'));
 const environment={...process.env},fetchBefore=globalThis.fetch;
 const job={id:'agent-owned-send',title:'Fixture Analyst',company:'Fixture Employer',location:'Sydney',platform:'indeed' as const,url:'https://recovery.fixture.invalid/apply'};
 const cv='Fictional candidate CV';
 const draft={id:'bfe2054d-e59a-4523-b810-4d46a7d0894a',revision:'b'.repeat(64),job,preparedAt:new Date().toISOString(),formUrl:job.url,answers:[],resume:'CV.txt',resumeId:'cv',resumeHash:createHash('sha256').update(cv).digest('hex')};
 Object.assign(process.env,{DATA_DIR:directory,CELERIS_API_KEY:'fixture-only',CELERIS_QUEUE_FILE:join(directory,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0',APPLICATION_AI_MODEL:'celeris',APPLICATION_REVIEW_MODE:'approved',APPROVED_APPLICATIONS_JSON:JSON.stringify([draft]),ALLOW_EXTERNAL_APPLY:'true',DRY_RUN:'false'});
 mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes/CV.txt'),cv);
 writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'cv',label:'Fixture CV',fileName:'CV.txt'}]));
 writeFileSync(join(directory,'approved-applications.json'),JSON.stringify([draft]));
 const {runAgentOnlyApplication}=await import('./agent-only.js');
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')?route.fulfill({contentType:'text/html',body:`<main><h1>Fixture Analyst at Fixture Employer</h1><p>Sydney</p><button id="coordinate" onclick="document.body.dataset.coordinate='done'">Recover widget</button><button id="dialog" onclick="setTimeout(()=>{document.body.dataset.accepted=String(confirm('Continue recovery?'))},0)">Open dialog</button><button id="send" onclick="document.body.dataset.sends=String(Number(document.body.dataset.sends||0)+1);document.querySelector('main').textContent='Application received: OWNED123'">Submit application</button></main>`}):route.abort());
  await page.goto(job.url);
  let turn=0;
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const specialist=specialistFixtureReply(body);if(specialist)return specialist;
   turn++;assert.ok(turn<=8,'no forced review or replay may add a model turn');
   const action=body.tools.find((tool:any)=>tool.function.name==='browser_action').function.parameters;
   assert.ok(action.properties.action.enum.includes('script'));
   assert.ok(action.properties.target_mode.enum.includes('coordinates'));
   assert.doesNotMatch(String(body.messages.at(-1).content),/^APPLICATION REVIEW ADVICE:/);
   let name='browser_action',args:Record<string,unknown>;
   if(turn===1)args={action:'navigate',value:job.url+'/recovery'};
   else if(turn===2){assert.equal(page.url(),job.url+'/recovery');args={action:'script',script:"document.body.dataset.script='done';return document.body.dataset.script",script_intent:'act'};}
   else if(turn===3){assert.equal(await page.locator('body').getAttribute('data-script'),'done');const box=(await page.locator('#coordinate').boundingBox())!;args={action:'click',target_mode:'coordinates',x:box.x+box.width/2,y:box.y+box.height/2};}
   else if(turn===4){assert.equal(await page.locator('body').getAttribute('data-coordinate'),'done');args={action:'click',selector:'#dialog'};}
   else if(turn===5)args={action:'dialog',value:'accept'};
   else if(turn===6){assert.equal(await page.locator('body').getAttribute('data-accepted'),'true');name='prepare_application';args={answers:[],resume_id:'cv',submit_selector:'#send'};}
   else if(turn===7){assert.match(String(body.messages.filter((m:any)=>m.role==='tool').at(-1)?.content),/Candidate approval and document checks passed/);args={action:'click',selector:'#send'};}
   else {assert.equal(await page.locator('body').getAttribute('data-sends'),'1');name='finish';args={status:'applied',reason:'Employer receipt observed',evidence:'Application received: OWNED123',receipt:{quote:'Application received: OWNED123'}};}
   return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'owned-'+turn,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:50,completion_tokens:10}});
  }) as typeof fetch;
  const result=await runAgentOnlyApplication({page,job,profile:{name:'Fictional Candidate',email:'candidate@fixture.invalid',skills:[]} as never,log:()=>{}});
  assert.equal(result.outcome.status,'applied',JSON.stringify(result.outcome));assert.equal(turn,8);
  assert.equal(await page.locator('body').getAttribute('data-sends'),'1');
 }finally{globalThis.fetch=fetchBefore;await browser.close();closeCelerisQueues();for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);rmSync(directory,{recursive:true,force:true});}
});
