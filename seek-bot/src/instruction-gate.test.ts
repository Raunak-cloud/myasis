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
globalThis.fetch=async (_url,init)=>{
 calls++;
 const body=JSON.parse(String(init?.body));
 assert.ok(body.response_format.json_schema.schema.properties.checks,'no fit review follows an unresolved instruction');
 const isReviewer=body.model==='celeris-1-magnus';
 const result=malformed || (isReviewer && reviewerMalformed) ? {conflict:'',because:'No conflict'} : {checks:[{
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
 assert.equal(independentlyExcluded.decision,'skip');assert.equal(independentlyExcluded.shouldApply,false);assert.equal(calls,6);
 reviewerMalformed=true;
 await assert.rejects(assessFit({...job,id:'invalid-review'},profile),/exception review violated/);
 console.log('PASS: unclear, contradicted, malformed and independently rejected exceptions never reach fit approval');
}finally{
 globalThis.fetch=originalFetch;
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-instruction-gate-'));
 rmSync(directory,{recursive:true,force:true});
}
