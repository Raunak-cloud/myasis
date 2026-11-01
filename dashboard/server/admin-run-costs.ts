import { query } from './db/index.js';
import { parseCostEvent,readCostJournal } from './application-costs.js';
import { userDir } from './userdata.js';
import type { UsageEvent } from '../src/application-cost.js';
import type { RunCost } from '../src/run-cost.js';

export interface CostRun {
  id:string;userId:string;startedAt:string;finishedAt:string|null;
  nextStartedAt:string|null;running:boolean;
}
export interface OwnerCostEvent {userId:string;event:UsageEvent}
export interface RepairCharge {userId:string;runId:string;costUsd:number;unknown:boolean;pending:boolean}
export function costRunEnd(run:CostRun):number {
  return Math.min(run.finishedAt?Date.parse(run.finishedAt)+1:Infinity,run.nextStartedAt?Date.parse(run.nextStartedAt):Infinity);
}

/** Sum actual journal entries, never application-level allocations. Explicit
 * run IDs take precedence; historical worker UUIDs require one unambiguous
 * start marker inside this account's run window. */
export function aggregateRunCosts(runs:CostRun[],records:OwnerCostEvent[],repairs:RepairCharge[]):Map<string,RunCost|null> {
  const result=new Map<string,RunCost|null>(runs.map(run=>[run.id,null]));
  const owners=new Map<string,CostRun[]>();
  for(const run of runs)owners.set(run.userId,[...(owners.get(run.userId)??[]),run]);
  const groups=new Map<string,{userId:string;events:Map<string,UsageEvent>}>();
  for(const {userId,event} of records){
    const key=`${userId}:${event.runId}`,group=groups.get(key)??{userId,events:new Map()};
    group.events.set(event.id,event);groups.set(key,group);
  }
  const ensure=(run:CostRun):RunCost=>{
    const cost=result.get(run.id)??{currency:'USD',totalUsd:0,knownCharges:0,incomplete:run.running||!run.finishedAt,estimated:false};
    result.set(run.id,cost);return cost;
  };
  for(const group of groups.values()){
    const events=[...group.events.values()],candidates=owners.get(group.userId)??[];
    const explicit=new Set(events.map(e=>e.runStartId).filter(Boolean));
    const starts=events.filter(e=>e.kind==='started');
    const matches=candidates.filter(run=>starts.some(e=>Date.parse(e.at)>=Date.parse(run.startedAt)&&Date.parse(e.at)<costRunEnd(run)));
    const legacy=explicit.size===0&&matches.length===1?matches[0]:undefined;
    const finished=new Set(events.filter(e=>e.kind==='finished').map(e=>e.runStartId??legacy?.id));
    for(const event of events){
      const run=event.runStartId?candidates.find(r=>r.id===event.runStartId):legacy;
      if(!run)continue;
      const cost=ensure(run);
      if(!finished.has(run.id))cost.incomplete=true;
      if(event.kind!=='usage')continue;
      if(typeof event.amountUsd==='number'&&Number.isFinite(event.amountUsd)&&event.amountUsd>=0){cost.totalUsd+=event.amountUsd;cost.knownCharges++;}
      else cost.incomplete=true;
      if(event.basis==='estimated')cost.estimated=true;
      if(event.basis==='unknown')cost.incomplete=true;
    }
  }
  for(const charge of repairs){
    const run=runs.find(r=>r.id===charge.runId&&r.userId===charge.userId);if(!run)continue;
    const hasJournal=result.get(run.id)!==null;
    const cost=ensure(run);
    if(Number.isFinite(charge.costUsd)&&charge.costUsd>=0&&(!charge.unknown||charge.costUsd>0)){cost.totalUsd+=charge.costUsd;cost.knownCharges++;}else cost.incomplete=true;
    if(!hasJournal)cost.incomplete=true;
    if(charge.unknown||charge.pending)cost.incomplete=true;
  }
  return result;
}

/** Admin routes supply database-owned IDs. Historical data comes from the
 * synced ledger; only active/recent workers need their unsynced local journal. */
export async function loadAdminRunCosts(runs:CostRun[]):Promise<Map<string,RunCost|null>> {
  if(!runs.length)return new Map();
  const windows=runs.map(run=>({id:run.id,user_id:run.userId,started_at:run.startedAt,
    end_at:Number.isFinite(costRunEnd(run))?new Date(costRunEnd(run)).toISOString():null}));
  const [rows,repairRows]=await Promise.all([
    query<{user_id:string;payload:UsageEvent}>(`WITH windows AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS w(id text,user_id bigint,started_at text,end_at text)
    ), scopes AS (
      SELECT DISTINCT e.user_id,e.run_id FROM application_cost_events e JOIN windows w ON e.user_id=w.user_id
      AND (e.payload->>'runStartId'=w.id OR (e.payload->>'runStartId' IS NULL AND e.payload->>'kind'='started'
        AND e.payload->>'at'>=w.started_at AND (w.end_at IS NULL OR e.payload->>'at'<w.end_at)))
    ) SELECT e.user_id::text,e.payload FROM application_cost_events e
      JOIN scopes s ON s.user_id=e.user_id AND s.run_id=e.run_id`,[JSON.stringify(windows)]),
    query<{user_id:string;run_id:string;cost_usd:string;cost_unknown:boolean;status:string}>(
      'SELECT user_id::text,run_id::text,cost_usd,cost_unknown,status FROM repair_pilot_cases WHERE run_id=ANY($1::bigint[])',[runs.map(r=>r.id)]),
  ]);
  const records:OwnerCostEvent[]=rows.flatMap(row=>{
    const event=parseCostEvent(JSON.stringify(row.payload));return event?[{userId:row.user_id,event}]:[];
  });
  const liveOwners=new Set(runs.filter(r=>r.running||r.finishedAt&&Date.parse(r.finishedAt)>Date.now()-120000).map(r=>r.userId));
  const unavailable=new Set<string>();
  for(const owner of liveOwners)try{
    for(const event of readCostJournal(userDir(owner)))records.push({userId:owner,event});
  }catch{unavailable.add(owner);console.warn('Live run cost journal unavailable for account',owner);}
  const result=aggregateRunCosts(runs,records,repairRows.map(r=>({userId:r.user_id,runId:r.run_id,costUsd:Number(r.cost_usd),
    unknown:r.cost_unknown,pending:!['complete','blocked','cancelled'].includes(r.status)})));
  for(const run of runs)if(unavailable.has(run.userId))result.set(run.id,{...(result.get(run.id)??{currency:'USD',totalUsd:0,knownCharges:0,estimated:false}),incomplete:true});
  return result;
}
