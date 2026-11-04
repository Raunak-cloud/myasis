import assert from 'node:assert/strict';
import {test} from 'node:test';
import {approvedRepairProof} from './approved-run-repairs.js';
const revision='a'.repeat(64);
const fixture=()=>({trace:{jobId:'12345678',runStartId:'42',mode:'approved',job:{url:'https://fixture.invalid/job/12345678'},outcome:{status:'skipped'},
 sendAudit:{attempted:false,approvedRevision:revision},steps:[{completedAt:'now',execution:'started',tool:'browser_action',args:{action:'click',sends_application:false},disposition:'completed'}]},
 state:{status:'finished',submissionAttempted:false,pending:null,scope:{runId:'42',jobId:'12345678',mode:'approved'}}});
test('only the exact approved revision with a finished durable no-send record can be selected',()=>{
 const f=fixture();assert.equal(approvedRepairProof(f.trace,f.state,revision),true);
 assert.equal(approvedRepairProof(f.trace,f.state,'b'.repeat(64)),false);
 for(const change of [{submissionAttempted:true},{pending:{tool:'browser_action'}},{status:'active'},{scope:{runId:'99',jobId:'12345678',mode:'approved'}},
  {investigations:[{kind:'submission',status:'unresolved'}]}])assert.equal(approvedRepairProof(f.trace,{...f.state,...change},revision),false);
 assert.equal(approvedRepairProof({...f.trace,mode:'prepare'},f.state,revision),false);
 assert.equal(approvedRepairProof({...f.trace,outcome:{status:'applied'}},f.state,revision),false);
});
test('a requested send is eligible only when the code guard refused it and the durable record confirms no attempt',()=>{
 const f=fixture();const step={...f.trace.steps[0],args:{action:'click',sends_application:true},disposition:'reobserve',
  result:'Before this send, review actual saved answers, documents and vacancy with candidate sources using record_application_review. No send was attempted or queued. Inspect the next observation.'};
 assert.equal(approvedRepairProof({...f.trace,steps:[step]},f.state,revision),true);
 assert.equal(approvedRepairProof({...f.trace,steps:[{...step,disposition:'completed'}]},f.state,revision),false);
 assert.equal(approvedRepairProof({...f.trace,steps:[{...step,result:'Submit clicked, waiting for receipt.'}]},f.state,revision),false);
 assert.equal(approvedRepairProof({...f.trace,steps:[step]},{...f.state,submissionAttempted:true},revision),false);
});
test('ambiguous writes, incomplete operations, scripts, helpers and coordinate clicks are not automatically replayed',()=>{
 const f=fixture();
 for(const change of [{completedAt:undefined},{tool:'send_email_application'},{tool:'helper_unknown'},
  {args:{action:'click'}},{args:{action:'script'}},{args:{action:'press',sends_application:false}},
  {args:{action:'click',sends_application:false,x:1,y:2}},{args:{action:'navigate',value:'https://fixture.invalid/other'}}])
  assert.equal(approvedRepairProof({...f.trace,steps:[{...f.trace.steps[0],...change}]},f.state,revision),false);
});
test('scroll offsets and code-only malformed-report diagnostics do not become possible sends',()=>{
 const f=fixture();const scroll={...f.trace.steps[0],args:{action:'scroll',x:0,y:800}};
 const report={tool:'finish',label:'Recovery checkpoint response rejected'};
 assert.equal(approvedRepairProof({...f.trace,steps:[scroll,report]},f.state,revision),true);
 assert.equal(approvedRepairProof({...f.trace,steps:[scroll,{...report,execution:'started'}]},f.state,revision),false);
});
