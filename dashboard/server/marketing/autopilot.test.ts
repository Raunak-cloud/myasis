import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticPublicationHold, newGrowthRun, nextGrowthTopic, resultsBrief, runGrowthSteps } from './autopilot.js';
import type { MarketingSite, MarketingTopic, OrganicStrategy, ResultsSnapshot } from '../../src/marketingTypes.js';

test('growth review checkpoints completed work, resumes an interrupted step and preserves provider failures',async()=>{
  const report=newGrowthRun();report.steps[0].status='done';report.steps[0].summary='Saved measurements';report.steps[1].status='running';
  const called:string[]=[],saved:string[]=[];
  await runGrowthSteps(report,{allowed:async()=>true,save:async r=>{saved.push(JSON.stringify(r));},perform:async key=>{called.push(key);if(key==='health') throw new Error('private provider details');return {status:'done',summary:`Saved ${key}`};},error:()=> 'The health check could not finish.'});
  assert.deepEqual(called,['health','research','visibility','strategy','content']);
  assert.equal(report.steps[0].summary,'Saved measurements');assert.equal(report.steps[1].status,'attention');assert.ok(report.completedAt);assert.equal(saved.length,11);
  await runGrowthSteps(report,{allowed:async()=>true,save:async()=>assert.fail('Finished review must not run again'),perform:async()=>{throw new Error('Duplicate run');},error:()=>''});
});
test('pausing a growth run prevents remaining actions while retaining completed evidence',async()=>{
  const report=newGrowthRun();let enabled=true;const called:string[]=[];
  await runGrowthSteps(report,{allowed:async()=>enabled,save:async()=>{},perform:async key=>{called.push(key);enabled=false;return {status:'done',summary:'Saved'};},error:()=>''});
  assert.deepEqual(called,['results']);assert.equal(report.steps[0].status,'done');assert.ok(report.steps.slice(1).every(s=>s.status==='skipped'));
});
test('a checkpoint storage failure escapes instead of claiming work was saved',async()=>{
  const report=newGrowthRun();let acted=false;
  await assert.rejects(runGrowthSteps(report,{allowed:async()=>true,save:async()=>{throw new Error('Database offline');},perform:async()=>{acted=true;return {status:'done',summary:'Saved'};},error:()=>''}),/Database offline/);
  assert.equal(acted,false);assert.equal(report.completedAt,null);
});
const topic=(id:string,intent:MarketingTopic['intent'],status:MarketingTopic['status']='planned')=>({id,intent,status,priority:'high',createdAt:'2026-01-01'} as MarketingTopic);
test('goal selection excludes overlap, dismissed actions and already drafted topics',()=>{
  const topics=[topic('overlap','buy'),topic('dismissed','buy'),topic('draft','buy','drafted'),topic('learn','learn'),topic('compare','compare'),topic('buy','buy')];
  const strategy={actions:topics.map(t=>({topicId:t.id,kind:t.id==='overlap'?'refresh':'new',status:t.id==='dismissed'?'dismissed':'open'}))} as OrganicStrategy;
  assert.equal(nextGrowthTopic(topics,strategy,'sales')?.id,'buy');assert.equal(nextGrowthTopic(topics,strategy,'leads')?.id,'compare');
  assert.equal(nextGrowthTopic(topics.slice(0,3),strategy,'sales'),null);
});
test('automatic publication needs a confirmed profile and a recent readable audit without urgent findings',()=>{
  const now=Date.parse('2026-10-06T05:00:00Z');
  const site={profileConfirmed:true,health:{checkedAt:new Date(now).toISOString(),pages:[{status:200,error:null}],findings:[]}} as unknown as MarketingSite;
  assert.equal(automaticPublicationHold(site,now),null);
  assert.match(automaticPublicationHold({...site,profileConfirmed:false},now)!,/Confirm/);
  assert.match(automaticPublicationHold({...site,health:null},now)!,/recent/);
  assert.match(automaticPublicationHold({...site,health:{...site.health!,checkedAt:'2025-01-01'}},now)!,/recent/);
  assert.match(automaticPublicationHold({...site,health:{...site.health!,pages:[]}},now)!,/No public pages/);
  assert.match(automaticPublicationHold({...site,health:{...site.health!,findings:[{severity:'urgent'} as never]}},now)!,/urgent/);
});
test('weekly results retain source periods, measured zero and absolute change without claiming attribution',()=>{
  const report={source:'search-console',method:'api',sourceLabel:'GSC',periodStart:'2026-09-01',periodEnd:'2026-09-28',clicks:0,previous:{clicks:12}} as ResultsSnapshot;
  const text=resultsBrief([report]);assert.match(text,/0 search clicks; -12/);assert.match(text,/2026-09-01 to 2026-09-28/);assert.match(text,/not proof/);
  assert.match(resultsBrief([{...report,method:'import'}]),/No connected API measurements/);
  assert.match(resultsBrief([{...report,clicks:null}]),/unmeasured search clicks/);
});
