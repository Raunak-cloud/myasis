import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'patchright';
import {withApplicationModel} from './application-model.js';
import {config} from './config.js';
import {identifyDirectJob,runDirectExternalApplication} from './direct-external.js';
import {captureApplicationFailure} from './application-diagnostics.js';
import type {FitAssessment} from './llm.js';

test('Google vacancy identity uses its main role heading instead of the generic H1',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<meta property="og:title" content="Security Engineering Manager, Detection and Response"><h1>job details</h1><aside><h2>Jobs search results</h2><p>Unrelated sales recommendation.</p></aside><main><h2>Security Engineering Manager, Detection and Response</h2><p>Google</p><p>Review security designs and lead technical security assessments in Sydney.</p></main>'}));
  await page.goto('https://www.google.com/about/careers/applications/jobs/results/123456789-security-engineering-manager');
  const job=await identifyDirectJob(page);
  assert.equal(job.title,'Security Engineering Manager, Detection and Response');
  assert.equal(job.company,'Google');
  assert.match(job.description,/technical security assessments in Sydney/);
  assert.doesNotMatch(job.description,/Unrelated sales recommendation/);
 }finally{await browser.close();}
});

test('Workday additional locations are read without credentials and bound to the exact requisition',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const context=await browser.newContext();
  await context.addCookies([{name:'candidate-session',value:'fixture-only',domain:'pwc.wd3.myworkdayjobs.com',path:'/'}]);
  const page=await context.newPage();let reads=0,wrongRequisition=false;
  await page.route('**/*',route=>{
   if(route.request().url().includes('/wday/cxs/')){
    reads++;assert.equal(route.request().url(),'https://pwc.wd3.myworkdayjobs.com/wday/cxs/pwc/crm_experienced_careers_site/job/Melbourne/Senior-Penetration-Tester_770119WD');
    assert.equal(route.request().headers().cookie,undefined,'Public vacancy enrichment must not send candidate cookies.');
    return route.fulfill({contentType:'application/json',body:JSON.stringify({jobPostingInfo:{title:'Senior Penetration Tester',jobReqId:wrongRequisition?'OTHER123':'770119WD',location:'Melbourne',additionalLocations:['Sydney']}})});
   }
   return route.fulfill({contentType:'text/html',body:'<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Penetration Tester","hiringOrganization":{"name":"PwC"},"jobLocation":{"address":{"addressLocality":"Melbourne"}},"description":"Perform application penetration tests."}</script><main><h1>Senior Penetration Tester</h1><p>Melbourne</p></main>'});
  });
  await page.goto('https://pwc.wd3.myworkdayjobs.com/en-US/crm_experienced_careers_site/job/Melbourne/Senior-Penetration-Tester_770119WD');
  const job=await identifyDirectJob(page);
  assert.equal(reads,1);assert.equal(job.location,'Melbourne; Sydney');
  wrongRequisition=true;
  assert.equal((await identifyDirectJob(page)).location,'Melbourne','A different requisition must not add locations.');
 }finally{await browser.close();}
});

test('direct URL must pass current-preference review before any application action',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'direct-preferences-')),previous={dry:config.dryRun,external:config.allowExternalApply};
 config.dryRun=true;config.allowExternalApply=true;
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1 hidden>Unsupported browser</h1><main><h1>Inventory Counter</h1><p>Count store inventory and reconcile stock sheets.</p><label>Name<input id=name></label><button>Apply</button></main>'}));
 const url='https://employer.fixture.invalid/job/stocktaking';
 const profile={name:'Alex Fixture',email:'fixture@example.invalid',phone:'',nationality:'',expectedSalary:'',noticePeriod:'',willingToRelocate:false,experienceSummary:'Software CV; current career change to stocktaking.',skills:[],excludedDomains:[],securityClearance:''};
 const fit:FitAssessment={decision:'apply',shouldApply:true,matchScore:85,reason:'Physical stock counts are requested.',evidence:['Count store inventory.'],injectionSuspected:false};
 let actions=0,reviews=0;
 try {await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false'},async()=>{
  const match:typeof import('./llm.js').assessFit=async job=>{
   reviews++;assert.equal(job.title,'Inventory Counter');assert.equal(job.source,'search');
   assert.match(job.description??'',/Count store inventory/);assert.equal(await page.locator('#name').inputValue(),'');
   return {...fit,decision:'skip',shouldApply:false,reason:'Fixture preference conflict.'};
  };
  await runDirectExternalApplication(page,url,profile,()=>null,{match,runAgent:async()=>{actions++;throw Error('Must not apply after failed review.');}});
  assert.equal(actions,0);assert.equal(reviews,1);
  await runDirectExternalApplication(page,url+'?allowed',profile,()=>null,{match:async()=>fit,runAgent:async({job})=>{
   actions++;assert.equal(job.source,'search','A URL never impersonates a candidate approval.');assert.equal(job.fitReview?.score,85);
   assert.equal(job.fitReview?.reason,fit.reason);
   return {outcome:{status:'needs-human',reason:'Exact employment month is unknown.',questions:[{question:'Employment start month?',kind:'text'}]},captured:[],actions:[],submitPressed:false,steps:1,usage:'offline fixture'};
  }});
  assert.equal(actions,1);
  const failure=new Error('Synthetic error after possible send');
  await runDirectExternalApplication(page,url+'?uncertain',profile,()=>null,{match:async()=>fit,runAgent:async({page,job})=>{
   actions++;captureApplicationFailure(page,job.id,failure,{stage:'agent-loop',submitPressed:true});throw failure;
  }});
  assert.equal(actions,2,'Orchestration never retries an uncertain send.');
  const rows=readFileSync(join(dir,'run-log.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows[0].status,'skipped');assert.equal(rows[1].status,'needs-human');assert.equal(rows[2].status,'error');assert.equal(rows[2].submitPressed,true);
 });}finally{await browser.close();config.dryRun=previous.dry;config.allowExternalApply=previous.external;rmSync(dir,{recursive:true,force:true});}
});
