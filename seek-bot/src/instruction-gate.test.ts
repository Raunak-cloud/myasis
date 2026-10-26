import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'owtomate-instruction-gate-'));
process.env.DATA_DIR=directory;
process.env.CELERIS_API_KEY='fixture-only';
const {config}=await import('./config.js');
const {assessFit}=await import('./llm.js');
config.aiInstructions='Avoid manager roles. Exception: junior product manager roles are allowed.';
const originalFetch=globalThis.fetch;
let status='unclear';let calls=0;let malformed=false;
let reviewerStatus='not-met';let reviewerMalformed=false;
let repairSucceeds=false;
globalThis.fetch=async (_url,init)=>{
 calls++;
 const body=JSON.parse(String(init?.body));
 if(!body.response_format.json_schema.schema.properties.checks) {
  assert.ok(repairSucceeds && reviewerStatus==='met','no fit review follows an unresolved instruction');
  return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({workArrangementCheck:{offered:['onsite'],evidence:'Fixture office work'},instructionCheck:{violated:false,ruleQuote:'',explanation:'The independently verified exception permits this vacancy.'},decision:'apply',matchScore:80,reason:'Fixture fit',evidence:['Fixture evidence'],injectionSuspected:false})}}]}),{status:200});
 }
 const isReviewer=body.model==='celeris-1-magnus';
 const correction=String(body.messages[0].content).includes('EVIDENCE CORRECTION');
 if(correction) assert.match(body.messages[0].content,/checks must contain at least one instruction check/);
 const result=malformed || (isReviewer && reviewerMalformed && !(correction && repairSucceeds)) ? {conflict:'',because:'No conflict'} : {checks:[{
  ruleQuote:'Avoid manager roles.',status:'satisfied',reason:'The level is not established.',
  exceptionQuote:'junior product manager roles are allowed',exceptionConditions:[{conditionQuote:'junior',status:isReviewer ? reviewerStatus : status,jobEvidence:'The advertised level.'}],
 }],injectionSuspected:false};
 return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(result)}}]}),{status:200});
};
const profile={name:'Fixture',phone:'',email:'fixture@example.test',suburb:'Sydney',state:'NSW',nationality:'',expectedSalary:'',noticePeriod:'',willingToRelocate:false,experienceSummary:'',skills:[],excludedDomains:[],securityClearance:''};
try{
 const job={id:'unclear',title:'Product Manager',company:'Fixture',description:'Own a product roadmap.',location:'Sydney',url:'https://fixture.invalid'};
 const held=await assessFit(job,profile);
 assert.equal(held.decision,'uncertain');assert.equal(held.shouldApply,false);assert.equal(calls,1);
 status='not-met';
 const excluded=await assessFit({...job,id:'excluded'},profile);
 assert.equal(excluded.decision,'skip');assert.equal(excluded.shouldApply,false);assert.equal(calls,2);
 malformed=true;
 await assert.rejects(assessFit({...job,id:'invalid'},profile),/evidence schema/);
 malformed=false;status='met';
 const independentlyExcluded=await assessFit({...job,id:'reviewed-exception'},profile);
 assert.equal(independentlyExcluded.decision,'skip');assert.equal(independentlyExcluded.shouldApply,false);assert.equal(calls,7);
 reviewerMalformed=true;
 const beforeInvalid=calls;
 await assert.rejects(assessFit({...job,id:'invalid-review'},profile),/exception review violated/);
 assert.equal(calls-beforeInvalid,3,'an invalid exception review gets exactly one correction attempt');
 repairSucceeds=true;
 const repaired=await assessFit({...job,id:'corrected-review'},profile);
 assert.equal(repaired.decision,'skip');assert.equal(repaired.shouldApply,false);
 reviewerStatus='unclear';
 const repairedUnclear=await assessFit({...job,id:'corrected-unclear'},profile);
 assert.equal(repairedUnclear.decision,'uncertain');assert.equal(repairedUnclear.shouldApply,false);
 reviewerStatus='met';
 const beforeAllowed=calls;
 const repairedAllowed=await assessFit({...job,id:'corrected-allowed'},profile);
 assert.equal(repairedAllowed.decision,'apply');assert.equal(repairedAllowed.shouldApply,true);
 assert.equal(calls-beforeAllowed,4,'fit review runs only after the corrected exception evidence is valid');
 console.log('PASS: unclear, contradicted, malformed and independently rejected exceptions never reach fit approval');
}finally{
 globalThis.fetch=originalFetch;
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-instruction-gate-'));
 rmSync(directory,{recursive:true,force:true});
}
