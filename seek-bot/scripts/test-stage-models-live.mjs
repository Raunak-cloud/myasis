// Fictional evidence and non-executing tools only. No browser or employer starts.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {cases} from './fit-model-cases.mjs';
assert.ok(process.argv.includes('--live'), 'Explicit live probe required.');
assert.ok(process.env.CELERIS_API_KEY?.trim() && process.env.OPENROUTER_API_KEY?.trim());
const dir=mkdtempSync(join(tmpdir(),'stage-live-'));
Object.assign(process.env,{DATA_DIR:dir,COST_TRACKING:'true',APPLICATION_AI_MODEL:'minimax',DRY_RUN:'true',APPLICATION_REVIEW_MODE:'',RESUME_SELECT:'fixture-cv'});
for(const key of ['OWTOMATE_RUN_START_ID','OWTOMATE_USER_ID','OWTOMATE_LIVE_REPAIR']) delete process.env[key];
const {config}=await import('../dist/config.js');
const {assessFit}=await import('../dist/llm.js');
const {applicationChat}=await import('../dist/agent/application-chat.js');
const {consultApplicationSpecialist}=await import('../dist/agent/consultation.js');
const {CostMeter}=await import('../dist/agent/celeris.js');
const {closeCelerisQueues}=await import('../../shared/celeris-queue.mjs');
const input=structuredClone(cases.find(row=>row.id==='android').input);
mkdirSync(join(dir,'resumes'));
writeFileSync(join(dir,'resumes','fixture.txt'),input.profile.experienceSummary);
writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'fixture-cv',label:'Fictional CV',fileName:'fixture.txt',isDefault:true}]));
writeFileSync(join(dir,'answers.json'),'[]');
config.aiInstructions=input.instruction; config.keywords=input.keywords; config.targetRole=input.targetRole;
config.resume.select='fixture-cv'; Object.assign(config.rules,input.rules);
let stage='review'; const wire=[],original=globalThis.fetch,started=Date.now();
globalThis.fetch=async(url,init)=>{
  assert.ok(wire.length<5,'At most five provider calls, including format retries.');
  const body=JSON.parse(String(init?.body)),target=new URL(String(url));
  assert.equal(body.model,stage==='review'?'celeris-1-magnus':'minimax/minimax-m3.1-flash');
  assert.equal(target.hostname,stage==='review'?'inference.celeris.ai':'openrouter.ai');
  wire.push({stage,model:body.model}); return original(url,init);
};
const report={startedAt:new Date().toISOString(),passed:false,wire,employerStarts:0,browserOperations:0};
try {
  const fit=await assessFit(input.job,input.profile); assert.equal(fit.decision,'skip'); report.fitDecision=fit.decision;
  stage='application';
  const app=await applicationChat({model:'celeris-1-magnus',messages:[{role:'system',content:'You have no browser and cannot submit anything. Return the requested fictional plan only.'},
    {role:'user',content:'A fictional form needs an exact start month, but only two years of employment duration are known. Call return_plan with action ask and grounded false. Never infer a date.'}],
    tools:[{name:'return_plan',description:'Return a non-executing fictional plan.',parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['ask']},grounded:{type:'boolean',enum:[false]}},required:['action','grounded']}}],
    forceTool:'return_plan',maxTokens:2048,meter:new CostMeter(.15),deadline:Date.now()+18000});
  assert.deepEqual(app.toolCalls.map(call=>({name:call.name,args:call.args})),[{name:'return_plan',args:{action:'ask',grounded:false}}]);
  stage='supervisor';
  const noAccess=new Proxy({},{get(){throw Error('Specialist attempted browser access.');}});
  const ctx={page:noAccess,guards:noAccess,profile:input.profile,job:input.job,
    observation:{url:'https://fixture.invalid/apply',title:'Fictional form',text:'Employment start month required; only duration is known.',actions:[],fields:[{ref:'date',label:'Employment start month',kind:'text',required:true,currentValue:''}]},
    captured:[],actions:[],resumeUsed:'fixture-cv',log:()=>{}};
  const advice=await consultApplicationSpecialist(ctx,{question:'Can the parent infer an exact start month from a two-year duration? Explain the truthful next step.'},{enabled:true,meter:new CostMeter(.15)});
  assert.equal(advice.kind,'ok'); assert.match(advice.message,/READ-ONLY SPECIALIST ADVICE/);
  assert.ok(wire.some(row=>row.stage==='supervisor')); report.passed=true;
} finally {
  globalThis.fetch=original; closeCelerisQueues(); report.finishedAt=new Date().toISOString(); report.elapsedMs=Date.now()-started;
  const ledger=readFileSync(join(dir,'cost-ledger.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const model=ledger.filter(row=>['Celeris','OpenRouter'].includes(row.provider));
  report.costUsd=model.reduce((sum,row)=>sum+(row.amountUsd??0),0);
  report.unknownModelCharges=model.filter(row=>row.amountUsd===null).length;
  report.infrastructureEntries=ledger.length-model.length;
  writeFileSync(resolve(process.env.STAGE_MODEL_SMOKE_OUTPUT??join(dir,'report.json')),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));
}
