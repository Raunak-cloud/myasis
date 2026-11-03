// Bounded, fictional suitability probes. No browser and no applications.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {cases} from './fit-model-cases.mjs';
assert.ok(process.argv.includes('--live'),'Explicit live evaluation required.');
assert.ok(process.env.CELERIS_API_KEY?.trim());
const root=mkdtempSync(join(tmpdir(),'current-intent-live-'));
Object.assign(process.env,{DATA_DIR:root,COST_TRACKING:'true',APPLICATION_AI_MODEL:'minimax',DRY_RUN:'true',RESUME_SELECT:'fixture',APPLICATION_REVIEW_MODE:''});
for(const key of ['OWTOMATE_RUN_START_ID','OWTOMATE_USER_ID','OWTOMATE_LIVE_REPAIR'])delete process.env[key];
const {config}=await import('../dist/config.js');
const {assessFit}=await import('../dist/llm.js');
const {closeCelerisQueues}=await import('../../shared/celeris-queue.mjs');
const ids=['android','stock-count','pet-walk','ranger','stock-duties-title','injection-it'];
const records=[],wire=[],original=globalThis.fetch,started=Date.now();let current;
globalThis.fetch=async(url,init)=>{
 assert.ok(wire.length<10,'Ten provider requests maximum including format corrections.');
 const body=JSON.parse(String(init?.body));assert.equal(new URL(String(url)).hostname,'inference.celeris.ai');assert.equal(body.model,'celeris-1-magnus');
 wire.push({case:current,model:body.model});return original(url,init);
};
const report={passed:false,startedAt:new Date().toISOString(),records,wire,employerStarts:0,browserOperations:0};
try {
 for(const id of ids){
  const row=cases.find(row=>row.id===id);assert.ok(row,id);const input=structuredClone(row.input);
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
  writeFileSync(resolve(process.env.CURRENT_PREFERENCE_PROBE_OUTPUT??join(root,'report.json')),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 });
}
