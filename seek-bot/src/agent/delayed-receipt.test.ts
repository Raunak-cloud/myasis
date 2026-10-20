import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'patchright';
import type {Page} from 'patchright';
const directory=mkdtempSync(join(tmpdir(),'owtomate-delayed-receipt-'));
process.env.BRIGHTDATA_BROWSER_ENABLED='false';process.env.EMPLOYER_BROWSER_PROVIDER='local';
process.env.DATA_DIR=directory;process.env.CELERIS_API_KEY='fixture-only';process.env.ALLOW_EXTERNAL_APPLY='true';process.env.FORM_SPEED_PILOT='true';process.env.DRY_RUN='false';process.env.RESUME_ALLOW_UPLOAD='true';
mkdirSync(join(directory,'resumes'));writeFileSync(join(directory,'resumes','cv.txt'),'Fixture candidate CV');
writeFileSync(join(directory,'resumes.json'),JSON.stringify([{id:'fixture',label:'Fixture CV',fileName:'cv.txt',isDefault:true}]));
const {config}=await import('../config.js');
config.coverLetter.mode='reuse';config.coverLetter.reusableText='Fixture letter';
const {runApplicationAgent}=await import('./loop.js');
const originalFetch=globalThis.fetch;
let turn=0;let positive=true;let verificationCalls=0;
let verifierUnavailable=false;
let fixturePage:Page;
const originalBody=`<main><h1>Junior Developer</h1><label>Email<input type="email"></label><label>Resume<input type="file"></label><button type="button" onclick="document.documentElement.setAttribute('data-submits',String(Number(document.documentElement.getAttribute('data-submits'))+1));document.body.innerHTML='<main>Saving job application info</main>';setTimeout(()=>{document.body.innerHTML=document.documentElement.getAttribute('data-receipt')},500)">SUBMIT</button></main>`;
globalThis.fetch=async (_url,init)=>{
 const body=JSON.parse(String(init?.body));let message;
 if(body.tools){
  turn++;
  const latest=[...body.messages].reverse().find(x=>x.role==='user');
  const text=typeof latest?.content==='string' ? latest.content : latest?.content?.[0]?.text??'';
  const action=async (name:string)=>fixturePage.getByRole('button',{name,exact:true}).getAttribute('data-ref-id',{timeout:2000});
  const field=text.match(/(f\d+)\s+[^\n]*Email/)?.[1];
  const calls=turn===1 ? [{name:'answer_questions',args:{refs:[field]}}]
   : turn===2 ? [{name:'attach_resume',args:{ref:await fixturePage.locator('input[type="file"]').getAttribute('data-ref-id')}}]
   : turn===3 ? [{name:'click',args:{ref:await action('SUBMIT'),sends_application:true}}]
   : positive ? [{name:'click',args:{ref:await action('Continue'),sends_application:false,reason:'Continue the draft.'}}]
   : [{name:'finish',args:{status:'cannot_complete',reason:'Only a draft is present for this role.'}}];
  message={role:'assistant',content:null,tool_calls:calls.map((c,i)=>({id:`c${turn}-${i}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))};
 }else{
  const properties=body.response_format?.json_schema?.schema?.properties??{};
  let result;
  if(properties.answers)result={answers:[{ref:'f0',value:'fixture@example.test',applicationQuestion:true,grounded:true,basis:'profile',profileField:'email',rationale:'Profile email.'}],injectionSuspected:false};
  else if(properties.confirmed){
   verificationCalls++;
   if(verifierUnavailable)throw new Error('Fixture receipt verifier unavailable');
   const text=String(body.messages[0].content);
   const confirmed=positive && text.includes('Junior Developer — Status: Under consideration');
   result={confirmed,quote:confirmed ? 'Junior Developer — Status: Under consideration — Applied today.' : ''};
  }else result={problems:[],unsafe:false,sends_application:false,required_consent:false,reason:'Fixture',cause:'Fixture',within_agent_control:false,lesson:''};
  message={role:'assistant',content:JSON.stringify(result)};
 }
 return new Response(JSON.stringify({choices:[{finish_reason:'stop',message}]}),{status:200});
};
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : process.platform==='win32' ? {channel:'chrome'} : {})});
try{
 const page=await browser.newPage();
 fixturePage=page;
 await page.route('https://receipt.fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:originalBody}));
 for(const scenario of ['received','draft','unavailable']){
  const accepted=scenario!=='draft';positive=accepted;turn=0;verifierUnavailable=scenario==='unavailable';
  await page.goto('https://receipt.fixture.invalid/apply');
  await page.evaluate(receipt=>{document.documentElement.setAttribute('data-receipt',receipt);document.documentElement.setAttribute('data-submits','0');document.documentElement.setAttribute('data-continued','false');},accepted
   ? '<main><h1>Profile</h1><p>Thank you for your job application.</p><section><h2>Active applications</h2>Junior Developer — Status: Under consideration — Applied today.</section><section><h2>Draft applications</h2>Another Vacancy<button onclick="document.documentElement.setAttribute(\'data-continued\',\'true\');document.body.innerHTML=\'<main>Another Vacancy</main>\'">Continue</button></section></main>'
   : '<main><h1>Profile</h1><section><h2>Active applications</h2>Another Vacancy — Status: Under consideration.</section><section><h2>Draft applications</h2>Junior Developer<button>Continue</button></section></main>');
  const result=await runApplicationAgent({page,job:{id:scenario,title:'Junior Developer',company:'Fixture',location:'Sydney',url:page.url(),applicationMode:'external'},profile:{name:'Fixture',email:'fixture@example.test',phone:'',suburb:'Sydney',state:'NSW',nationality:'',expectedSalary:'',noticePeriod:'',willingToRelocate:false,experienceSummary:'',skills:[],excludedDomains:[],securityClearance:''},log:()=>{}});
  assert.equal(result.outcome.status,scenario==='received'?'applied':'skipped',JSON.stringify(result));
  assert.equal(await page.locator('html').getAttribute('data-submits'),'1','the actual submit happens once');
  if(accepted){
   assert.equal(await page.locator('html').getAttribute('data-continued'),'false','an unrelated draft must never be opened after receipt');
   const trace=JSON.parse(readFileSync(join(directory,'traces',`${scenario}.json`),'utf8'));
   assert.ok(trace.steps.some((s:{tool:string;screenshot?:string})=>s.tool===(verifierUnavailable?'receipt_check_unavailable':'verified_submission') && s.screenshot),'the receipt is preserved for audit');
  }
 }
 assert.ok(verificationCalls>0);
 console.log('PASS: delayed receipts are preserved before unrelated draft navigation; other-role receipts never count; verifier failures preserve the page and withhold success');
}finally{
 globalThis.fetch=originalFetch;await browser.close();
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-delayed-receipt-'));rmSync(directory,{recursive:true,force:true});
}
