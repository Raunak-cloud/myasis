import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'patchright';
import {scenarios} from './fixtures.mjs';

const directory=mkdtempSync(join(tmpdir(),'owtomate-live-saved-form-'));
process.env.DATA_DIR=directory;process.env.DRY_RUN='true';process.env.FORM_SPEED_PILOT='true';
const {readSavedForm}=await import('../../dist/agent/saved-form.js');
const {reviewSavedApplicationForm}=await import('../../dist/llm.js');
const output=resolve('../output/magnus-recovery-simulation/saved-form-review/reviewer-results.json');
mkdirSync(resolve(output,'..'),{recursive:true});
const profile={name:'Fixture Candidate',email:'fixture@example.test',phone:'',suburb:'Lidcombe',state:'NSW',nationality:'',expectedSalary:'',noticePeriod:'',willingToRelocate:false,experienceSummary:'',skills:[],excludedDomains:[],securityClearance:''};
const results=[];
const usage=()=>{
 const totals={calls:0,costUsd:0};
 let lines=[];try{lines=readFileSync(join(directory,'pipeline-metrics.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
 for(const row of lines){if(row.stage!=='model'||!row.usage)continue;const u=row.usage;const cached=u.prompt_tokens_details?.cached_tokens??0;totals.calls++;totals.costUsd+=(Math.max(0,(u.prompt_tokens??0)-cached)*.2+cached*.02+(u.completion_tokens??0)*.7)/1e6;}
 return totals;
};
const persist=()=>writeFileSync(output,JSON.stringify({model:'celeris-1-magnus',fakeCandidateOnly:true,applicationsSubmitted:0,passed:results.filter(r=>r.passed).length,total:results.length,configuredTokenCost:usage(),results},null,2));
const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'chrome':undefined});
try{
 for(const scenario of scenarios){
  if(usage().costUsd>.25)throw Error('Saved-form reviewer test cost cap reached');
  const context=await browser.newContext({serviceWorkers:'block'});
  try{
   await context.route('**/*',route=>new URL(route.request().url()).hostname==='review.fixture.invalid'&&route.request().resourceType()==='document'
    ?route.fulfill({contentType:'text/html',body:scenario.html}):route.abort());
   const page=await context.newPage();await page.goto(`https://review.fixture.invalid/${scenario.id}`);
   const owner=scenario.frame?page.frames()[1]:page;await owner.locator('#target').waitFor();
   const job={id:`review-${scenario.id}`,title:'Developer',company:'Fixture Employer',location:'Sydney',url:page.url()};
   const check=async(phase,expected)=>{
    const form=await readSavedForm(page);const started=performance.now();let issues=[],error=null;
    try{issues=await reviewSavedApplicationForm(form,job,profile);}catch(e){error=e.message;}
    const target=form.fields.find(f=>f.label.startsWith(scenario.label));
    const correct=expected==='accepted'?issues.length===0:issues.some(p=>p.ref===target?.ref&&p.kind===expected);
    const result={case:scenario.id,phase,expected,passed:correct&&!error,seconds:Number(((performance.now()-started)/1000).toFixed(3)),issues,error};
    results.push(result);persist();console.log(JSON.stringify(result));
   };
   await check('initial',scenario.id==='missing-fact'?'needs_candidate':'invalid');
   if(scenario.id==='missing-fact')continue;
   // This click only prepares a known fixture state for judging. Repair
   // strategy is separately tested by the actual Magnus application loop.
   await owner.locator('li').filter({hasText:new RegExp(`^${scenario.approvedValue}$`)}).click();
   if(scenario.id!=='broken-service')await owner.locator('#target[aria-invalid="false"]').waitFor();
   await check('after-fixture-selection',scenario.id==='broken-service'?'invalid':'accepted');
  }finally{await context.close();}
 }
}finally{
 await browser.close();persist();
 if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-live-saved-form-'))throw Error('Unexpected temporary path');
 rmSync(directory,{recursive:true,force:true});
}
if(results.some(r=>!r.passed))process.exitCode=1;
console.log(`Saved-form reviewer: ${results.filter(r=>r.passed).length}/${results.length}. ${output}`);
