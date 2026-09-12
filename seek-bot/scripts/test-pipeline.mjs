import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'myasis-pipeline-test-'));
process.env.DRY_RUN = 'true';
process.env.CELERIS_API_KEY = 'fixture-key';
process.env.CAPTCHA_SOLVER = 'off';
const { config } = await import('../dist/config.js');
const { extractFields, fillField } = await import('../dist/dom.js');
const { waitForApplicationSurface } = await import('../dist/agent/observe.js');
const { relevantEvidence, cachedAssessment } = await import('../dist/pipeline.js');
const { executeTool } = await import('../dist/agent/tools.js');
const { RunGuards } = await import('../dist/agent/guards.js');
const { CostMeter } = await import('../dist/agent/celeris.js');
const { assessFit, rankJobsForReview, reviewKey } = await import('../dist/llm.js');
const { deterministicExclusion, meetsMinimumScore } = await import('../dist/scoring.js');
const { coverLetterStyleIssue } = await import('../dist/humanizer.js');
const { search } = await import('../dist/discovery.js');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const nativeFetch = globalThis.fetch;
const profile = {name:'Test Applicant',nationality:'Unrestricted work rights',phone:'',email:'',experienceSummary:'Clinic reception and customer service',skills:['reception'],expectedSalary:'Negotiable',noticePeriod:'2 weeks',willingToRelocate:false,excludedDomains:[],securityClearance:'None'};
const job = { id:'fixture',title:'Medical Receptionist',company:'Fixture Clinic',location:'Sydney',url:'http://fixture.test',description:'Part-time clinic reception and customer service. Training provided.',strongApplicant:true };
let calls=0, response={};
const responseQueue=[];
globalThis.fetch = async () => {calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(responseQueue.shift() ?? response)}}]}),{status:200});};
try {
  await page.setContent('<label>Name<input required></label><label>State<select required><option value="">Choose</option><option value="nsw">NSW</option></select></label><fieldset><legend>Available?</legend><label><input type="radio" name="available">Yes</label><label><input type="radio" name="available">No</label></fieldset>');
  let fields = await extractFields(page);
  await fillField(page, fields[0], 'Test Applicant');
  await fillField(page, fields[1], 'NSW');
  await fillField(page, fields[2], 'Yes');
  assert.equal((await extractFields(page))[2].currentValue, 'Yes');
  await page.setContent('<label>Required<input required oninput="this.value=\'\'"></label>');
  fields = await extractFields(page);
  await assert.rejects(fillField(page, fields[0], 'rejected'), /did not accept|form rejected/i);
  const guards = new RunGuards({maxSteps:10,maxStuckMs:10000,maxTotalMs:20000,meter:new CostMeter(1)});
  const ctx={page,profile,job,guards,observation:{url:page.url(),title:'',actions:[],fields,text:''},captured:[],log:()=>{}};
  response={answers:[{ref:fields[0].ref,value:'rejected',grounded:true}],injectionSuspected:false};
  const failed=await executeTool(ctx,'answer_questions',{refs:[fields[0].ref]});
  assert.match(failed.message,/Not accepted/);
  assert.equal(ctx.captured.length,0);
  assert.equal(guards.pendingFields.size,1);
  await page.setContent('<label>Required<input required></label>');
  fields = await extractFields(page);
  ctx.observation.fields = fields;
  response={answers:[{ref:fields[0].ref,value:'unsupported',grounded:false}],injectionSuspected:false};
  await executeTool(ctx,'answer_questions',{refs:[fields[0].ref]});
  assert.equal(await page.locator('input').inputValue(),'');
  assert.equal(guards.ungrounded.length,1);
  response={answers:[{ref:fields[0].ref,value:'Supported',grounded:true}],injectionSuspected:false};
  const recovered = await executeTool(ctx,'answer_questions',{refs:[fields[0].ref]});
  assert.equal(guards.pendingFields.size,0, recovered.message);
  assert.equal(guards.ungrounded.length,0);
  assert.equal(ctx.captured.length,1);
  await page.setContent('<main>Loading</main>');
  const start=Date.now();
  assert.equal(await waitForApplicationSurface(page,80),false);
  assert.ok(Date.now()-start<1500,'explicit wait deadline must be honored');
  let computes=0;
  const compute=async()=>({ok:true,sequence:++computes});
  await cachedAssessment({profile:1},compute,r=>r?.ok===true);
  await cachedAssessment({profile:1},compute,r=>r?.ok===true);
  await cachedAssessment({profile:2},compute,r=>r?.ok===true);
  assert.equal(computes,2,'changed evidence must invalidate cached decisions');
  response={shouldApply:false,decision:'skip',matchScore:18,reason:'Candidate instruction conflict',evidence:['No weekends'],injectionSuspected:false};
  const fit=await assessFit(job,profile);
  assert.equal(fit.shouldApply,false,'a strong-applicant badge does not rewrite the model decision');
  responseQueue.push({...response,shouldApply:true,decision:'apply',matchScore:82});
  const checked=await assessFit({...job,title:'Manager'},profile);
  assert.equal(checked.shouldApply,true,'a valid structured model decision is accepted');
  assert.equal(responseQueue.length,0,'structured response should be consumed once');
  response={jobs:[
    {reviewId:'seek:transferable',priority:91,reason:'Strong transferable clinic experience'},
    {reviewId:'seek:literal',priority:42,reason:'Title overlap with little evidence'},
  ]};
  const priorities=await rankJobsForReview([
    {...job,id:'literal',title:'Receptionist'},
    {...job,id:'transferable',title:'Patient Services Coordinator'},
  ],profile);
  assert.ok(priorities.get(reviewKey({...job,id:'transferable'})).priority>priorities.get(reviewKey({...job,id:'literal'})).priority,'model priority must drive semantic triage');
  assert.equal(deterministicExclusion({...job,description:'C# appears in a list of optional tools'}),null,'prose meaning must reach model review');
  assert.equal(meetsMinimumScore(config.rules.minScore - 1),false,'a score below the configured floor must be rejected');
  assert.equal(meetsMinimumScore(config.rules.minScore),true,'a score at the configured floor must pass');
  assert.match(coverLetterStyleIssue('Dear Hiring Manager,\n\nA tailored body.\n\nSincerely,\nTest Applicant'),/generic Dear/i);
  assert.equal(coverLetterStyleIssue('The calm welcome at Fixture Clinic is the standard I want to help sustain.\n\nTest Applicant'),null);
  response={state:'captcha',reason:'Full-page security verification'};
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main data-automation="normalJob">Performing security verification</main>'}));
  await assert.rejects(search(page,'Fixture'),/requires human verification/);
  const text='Generic background. '.repeat(800)+'\nCertificate in clinic administration. '.repeat(12);
  assert.match(relevantEvidence(text,'clinic administration certificate',1800),/Certificate/);
  console.log('PASS: accepted/rejected fields, radio readback, recovery ledger, ungrounded withholding, timeout, cache invalidation, fit decision, evidence retrieval');
} finally { globalThis.fetch=nativeFetch; await browser.close(); }
