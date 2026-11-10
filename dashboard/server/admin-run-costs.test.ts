import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRunCosts,readLiveCostRecords,type CostRun,type OwnerCostEvent } from './admin-run-costs.js';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { formatRunCost,runCostTitle } from '../src/run-cost.js';
import { parseCostEvent } from './application-costs.js';

const run=(id='10',userId='183',start='2026-11-01T01:00:00.000Z',end:string|null='2026-11-01T02:00:00.000Z'):CostRun=>
  ({id,userId,startedAt:start,finishedAt:end,nextStartedAt:null,running:!end});
let sequence=0;
const event=(kind:'started'|'usage'|'finished',amountUsd?:number|null,extra:Record<string,unknown>={}):OwnerCostEvent=>({userId:'183',event:{
  id:String(++sequence),runId:'worker-a',at:'2026-11-01T01:05:00.000Z',kind,...(amountUsd!==undefined?{amountUsd}:{}),...extra}});

test('run totals count shared review, unsuccessful attempts, multiple providers and repairs once, even without submissions',()=>{
  const records=[event('started'),event('usage',2,{provider:'Celeris',basis:'estimated'}),
    event('usage',3,{jobId:'failed-job'}),event('usage',4,{jobId:'prepared-job'}),
    event('usage',1,{provider:'Historical provider'}),event('finished')];
  const result=aggregateRunCosts([run()],[...records,records[1]],
    [{userId:'183',runId:'10',costUsd:.5,unknown:false,pending:false},{userId:'1',runId:'10',costUsd:999,unknown:false,pending:false}]).get('10')!;
  assert.equal(result.totalUsd,10.5);assert.equal(result.knownCharges,5);assert.equal(result.incomplete,false);assert.equal(result.estimated,true);
});
test('historical starts are account-scoped and bounded by the next run, including unfinished historical runs',()=>{
  const earlier={...run('10','183','2026-11-01T01:00:00.000Z',null),running:false,nextStartedAt:'2026-11-01T02:00:00.000Z'};
  const later=run('11','183','2026-11-01T02:00:00.000Z','2026-11-01T03:00:00.000Z');
  const records=[event('started'),event('usage',1),event('finished'),
    ...[event('started'),event('usage',7),event('finished')].map(r=>({...r,event:{...r.event,runId:'worker-b',at:'2026-11-01T02:00:00.000Z'}})),
    ...[event('started'),event('usage',999),event('finished')].map(r=>({...r,userId:'1'}))];
  const result=aggregateRunCosts([earlier,later],records,[]);
  assert.equal(result.get('10')!.totalUsd,1);assert.equal(result.get('11')!.totalUsd,7);
});
test('explicit identity wins over timestamps; missing or conflicting legacy starts are never guessed',()=>{
  const a=run(),b=run('11','183','2026-11-01T02:00:00.000Z','2026-11-01T03:00:00.000Z');
  const records=[event('started',undefined,{runStartId:'10'}),event('usage',4,{runStartId:'10',at:b.startedAt}),event('finished',undefined,{runStartId:'10'}),
    event('usage',999,{runStartId:'999'}),event('usage',999,{runId:'missing-start'})];
  const result=aggregateRunCosts([a,b],records,[]);
  assert.equal(result.get('10')!.totalUsd,4);assert.equal(result.get('11'),null);
  const overlap=aggregateRunCosts([a,{...a,id:'12'}],[event('started'),event('usage',50)],[]);
  assert.equal(overlap.get('10'),null);assert.equal(overlap.get('12'),null);
});
test('unknown usage, interrupted runs and pending repair costs remain visibly incomplete',()=>{
  for(const records of [[event('started'),event('usage',1)],[event('started'),event('usage',1),event('usage',null),event('finished')]]){
    const cost=aggregateRunCosts([run()],records,[]).get('10')!;
    assert.equal(cost.totalUsd,1);assert.equal(cost.incomplete,true);assert.equal(formatRunCost(cost),'US$1.0000 +');
  }
  const cost=aggregateRunCosts([run()],[event('started'),event('usage',0),event('finished')],[{userId:'183',runId:'10',costUsd:.2,unknown:true,pending:true}]).get('10')!;
  assert.equal(cost.totalUsd,.2);assert.equal(cost.incomplete,true);
  assert.equal(formatRunCost(aggregateRunCosts([run()],[event('started'),event('usage',null),event('finished')],[]).get('10')!),'Unavailable');
  assert.equal(formatRunCost(null),'—');
  assert.equal(formatRunCost({...cost,totalUsd:0,incomplete:false}),'US$0.0000');
  assert.equal(formatRunCost({...cost,totalUsd:.00001,incomplete:false}),'<US$0.0001');
  assert.match(runCostTitle(cost),/unpriced/);
  const repairOnly=aggregateRunCosts([run()],[],[{userId:'183',runId:'10',costUsd:.1,unknown:false,pending:false}]).get('10')!;
  assert.equal(repairOnly.incomplete,true,'a repair subtotal is not a complete application run total');
});
test('journal parsing accepts a trusted numeric run identity and rejects malformed associations',()=>{
  const value={id:'00000000-0000-4000-8000-000000000001',runId:'00000000-0000-4000-8000-000000000002',at:run().startedAt,kind:'usage',amountUsd:1};
  assert.equal(parseCostEvent(JSON.stringify({...value,runStartId:'1083'}))?.runStartId,'1083');
  for(const runStartId of ['../183',1083,''])assert.equal(parseCostEvent(JSON.stringify({...value,runStartId})),null);
});

test('live journals stream only relevant complete worker groups, including legacy records before their start marker',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'owtomate-live-costs-'));
  const old=randomUUID(),active=randomUUID(),legacy=randomUUID();
  const item=(runId:string,extra:Record<string,unknown>={})=>({id:randomUUID(),runId,at:run().startedAt,kind:'usage',amountUsd:1,...extra});
  const events=[...Array.from({length:2000},()=>item(old,{runStartId:'9',detail:'historical detail '.repeat(50)})),
    item(active,{runStartId:'10',kind:'started'}),item(active,{runStartId:'10'}),
    item(legacy),item(legacy,{kind:'started'}),item(legacy,{kind:'finished'})];
  try{
    writeFileSync(join(dir,'cost-ledger.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n{"incomplete":');
    const records=await readLiveCostRecords('183',[run()],dir);
    assert.equal(records.length,5);
    assert.ok(records.every(r=>r.user_id==='183'&&r.event.runId!==old&&!r.event.detail));
    assert.equal(aggregateRunCosts([run()],records.map(r=>({userId:r.user_id,event:r.event})),[]).get('10')!.totalUsd,2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
