// Bounded, fictional suitability probes. No browser and no applications.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {cases} from './fit-model-cases.mjs';
assert.ok(process.argv.includes('--live'),'Explicit live evaluation required.');
assert.ok(process.env.CELERIS_API_KEY?.trim());
const root=mkdtempSync(join(tmpdir(),'functional-equivalence-live-'));
Object.assign(process.env,{DATA_DIR:root,COST_TRACKING:'true',APPLICATION_AI_MODEL:'minimax',DRY_RUN:'true',RESUME_SELECT:'fixture',APPLICATION_REVIEW_MODE:''});
for(const key of ['OWTOMATE_RUN_START_ID','OWTOMATE_USER_ID','OWTOMATE_LIVE_REPAIR'])delete process.env[key];
const {config}=await import('../dist/config.js');
const {assessFit}=await import('../dist/llm.js');
const {closeCelerisQueues}=await import('../../shared/celeris-queue.mjs');
const probes=[
 {id:'inventory-office',title:'Inventory Assistant',expected:'skip',duty:'Maintain product and inventory information at head office. Key responsibilities: upload new products, maintain product information, update pricing and archive discontinued products; process stocktake information received from stores; prepare inventory reports; create and process purchase orders; perform Excel data entry and general administration. Inventory administration experience is desirable. Training provided.'},
 {id:'catalog-support',title:'Stock Records Clerk',expected:'skip',duty:'Maintain the product catalogue, prices, supplier purchase orders and stock-count data supplied by warehouse counters. This is an office administration job; no physical stock counts are performed in this role. Training provided.'},
 {id:'physical-counter',title:'Inventory Audit Assistant',expected:'apply',duty:'Perform physical stocktakes in Sydney stores: count items, scan barcodes, verify quantities and reconcile your count sheets. Complete the records for the counts you perform. Training provided; no licence or qualification required.'},
 {id:'stocktake-supervisor',title:'Inventory Supervisor',expected:'apply',duty:'Plan and supervise physical stocktakes in our Sydney warehouse. Direct stock counters, perform verification counts of raw materials and finished goods, investigate count discrepancies and reconcile the stocktake. Training provided; no formal qualification or licence required.'},
 {id:'walking-office',title:'Dog Walking Coordinator',expected:'skip',duty:'Office role booking dog walks, taking customer payments, scheduling walkers and maintaining their calendars. Other employees walk the dogs. No dog-walking duties. Customer service and administration training provided.'},
 {id:'walker-with-records',title:'Canine Adventure Assistant',expected:'apply',duty:'Walk customers pet dogs safely in small groups around Sydney. Provide water, check their wellbeing and send owners updates about the walks you perform. Personal dog-handling experience accepted, training provided. No driving or licence needed.'},
];
const selected=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
const ids=probes.filter(probe=>!selected||probe.id===selected).map(probe=>probe.id);
assert.ok(ids.length,'Unknown selected fictional case.');
const records=[],wire=[],original=globalThis.fetch,started=Date.now();let current;
globalThis.fetch=async(url,init)=>{
 assert.ok(wire.length<10,'Ten provider requests maximum including format corrections.');
 const body=JSON.parse(String(init?.body));assert.equal(new URL(String(url)).hostname,'inference.celeris.ai');assert.equal(body.model,'celeris-1-magnus');
 wire.push({case:current,model:body.model});return original(url,init);
};
const report={passed:false,startedAt:new Date().toISOString(),records,wire,employerStarts:0,browserOperations:0};
try {
 for(const id of ids){
  const probe=probes.find(probe=>probe.id===id);const row={...probe,input:structuredClone(cases.find(row=>row.id==='stock-count').input)};const input=row.input;input.job={...input.job,id,title:row.title,description:'Current genuine vacancy in Sydney, onsite. '+row.duty};
  // Match the account's current explicit role boundary, against a technical CV.
  input.instruction='Only apply dog walker and stocktaker';input.keywords=['pet walking','Stocktaking','Stocktaker'];
  const data=join(root,id);mkdirSync(join(data,'resumes'),{recursive:true});
  writeFileSync(join(data,'resumes','cv.txt'),input.profile.experienceSummary);
  writeFileSync(join(data,'resumes.json'),JSON.stringify([{id:'fixture',label:'Fictional CV',fileName:'cv.txt',isDefault:true}]));
  writeFileSync(join(data,'answers.json'),'[]');process.env.DATA_DIR=data;
  config.aiInstructions=input.instruction;config.keywords=input.keywords;config.targetRole=input.targetRole;config.resume.select='fixture';Object.assign(config.rules,input.rules);
  current=id;const fit=await assessFit(input.job,input.profile);
  records.push({id,title:input.job.title,expected:row.expected,decision:fit.decision,matched:fit.decision===row.expected});
  assert.equal(fit.decision,row.expected,id);
 }
 report.passed=true;
}finally{
 globalThis.fetch=original;closeCelerisQueues();report.elapsedMs=Date.now()-started;
 process.once('exit',()=>{
  const usage=ids.flatMap(id=>{const file=join(root,id,'cost-ledger.jsonl');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='usage'):[];});
  const models=usage.filter(row=>['Celeris','OpenRouter'].includes(row.provider));report.costUsd=models.reduce((sum,row)=>sum+(row.amountUsd??0),0);report.unknownModelCharges=models.filter(row=>row.amountUsd===null).length;report.infrastructureEntries=usage.length-models.length;
  writeFileSync(resolve(process.env.FUNCTIONAL_EQUIVALENCE_PROBE_OUTPUT??join(root,'report.json')),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 });
}
