import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { query } from './db/index.js';
import { parseCostEvent } from './application-costs.js';
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
  mergeRepairCosts(runs,result,repairs);
  return result;
}

function mergeRepairCosts(runs:CostRun[],result:Map<string,RunCost|null>,repairs:RepairCharge[]) {
  for(const charge of repairs){
    const run=runs.find(r=>r.id===charge.runId&&r.userId===charge.userId);if(!run)continue;
    const hasJournal=result.get(run.id)!==null;
    const cost=result.get(run.id)??{currency:'USD' as const,totalUsd:0,knownCharges:0,incomplete:run.running||!run.finishedAt,estimated:false};
    result.set(run.id,cost);
    if(Number.isFinite(charge.costUsd)&&charge.costUsd>=0&&(!charge.unknown||charge.costUsd>0)){cost.totalUsd+=charge.costUsd;cost.knownCharges++;}else cost.incomplete=true;
    if(!hasJournal)cost.incomplete=true;
    if(charge.unknown||charge.pending)cost.incomplete=true;
  }
}

// Aggregate beside the ledger. Shipping and JSON-copying thousands of raw
// events on every run-list poll caused large, repeatable dashboard RSS spikes.
// Explicit identities, ambiguous legacy starts and per-worker finish markers
// have exactly the same semantics as aggregateRunCosts above.
export const ADMIN_RUN_COST_SQL = `WITH windows AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS w(id text,user_id bigint,started_at text,end_at text)
), scopes AS (
  SELECT e.user_id,e.run_id FROM application_cost_events e JOIN windows w ON e.user_id=w.user_id AND e.payload->>'runStartId'=w.id
  UNION
  SELECT e.user_id,e.run_id FROM application_cost_events e JOIN windows w ON e.user_id=w.user_id
    AND e.payload->>'runStartId' IS NULL AND e.payload->>'kind'='started'
      AND (e.payload->>'at')::timestamptz>=w.started_at::timestamptz
      AND (w.end_at IS NULL OR (e.payload->>'at')::timestamptz<w.end_at::timestamptz)
), raw AS (
  SELECT e.user_id,e.event_id::text,e.run_id::text,e.payload,0 AS priority FROM application_cost_events e
    JOIN scopes s ON s.user_id=e.user_id AND s.run_id=e.run_id
  UNION ALL
  SELECT l.user_id::bigint,l.event->>'id',l.event->>'runId',l.event,1
    FROM jsonb_to_recordset($2::jsonb) AS l(user_id text,event jsonb)
), events AS (
  SELECT DISTINCT ON(user_id,event_id) user_id,event_id,run_id,payload FROM raw ORDER BY user_id,event_id,priority DESC
), groups AS (
  SELECT user_id,run_id,bool_or(payload->>'runStartId' IS NOT NULL) AS explicit FROM events GROUP BY user_id,run_id
), legacy AS (
  SELECT g.user_id,g.run_id,min(w.id) AS id FROM groups g JOIN events e USING(user_id,run_id)
    JOIN windows w ON w.user_id=e.user_id AND e.payload->>'kind'='started'
      AND (e.payload->>'at')::timestamptz>=w.started_at::timestamptz
      AND (w.end_at IS NULL OR (e.payload->>'at')::timestamptz<w.end_at::timestamptz)
    WHERE NOT g.explicit GROUP BY g.user_id,g.run_id HAVING count(DISTINCT w.id)=1
), assigned AS (
  SELECT w.id,e.user_id,e.run_id,e.payload FROM events e LEFT JOIN legacy l USING(user_id,run_id)
    JOIN windows w ON w.user_id=e.user_id AND w.id=COALESCE(e.payload->>'runStartId',l.id)
), workers AS (
  SELECT id,user_id,run_id,bool_or(payload->>'kind'='finished') AS finished FROM assigned GROUP BY id,user_id,run_id
)
SELECT a.id,
  COALESCE(sum((payload->>'amountUsd')::numeric) FILTER(WHERE payload->>'kind'='usage' AND jsonb_typeof(payload->'amountUsd')='number'),0)::text AS total,
  count(*) FILTER(WHERE payload->>'kind'='usage' AND jsonb_typeof(payload->'amountUsd')='number')::int AS known,
  bool_or(NOT workers.finished OR (payload->>'kind'='usage' AND
    (COALESCE(jsonb_typeof(payload->'amountUsd'),'null')<>'number' OR payload->>'basis'='unknown'))) AS incomplete,
  bool_or(payload->>'kind'='usage' AND payload->>'basis'='estimated') AS estimated
FROM assigned a JOIN workers USING(id,user_id,run_id) GROUP BY a.id`;

/** Read complete local records without holding the account's lifetime journal
 * in memory. Only worker groups relevant to active/recent windows are retained. */
export async function readLiveCostRecords(owner:string,runs:CostRun[],directory=userDir(owner)):Promise<Array<{user_id:string;event:UsageEvent}>> {
  const file=resolve(directory,'cost-ledger.jsonl');
  if(!existsSync(file))return [];
  const ids=new Set(runs.map(r=>r.id)),workers=new Set<string>();
  const each=async(visit:(e:UsageEvent)=>void)=>{
    const input=createReadStream(file,{encoding:'utf8',highWaterMark:64*1024});
    const lines=createInterface({input,crlfDelay:Infinity});
    try{for await(const line of lines){const event=parseCostEvent(line);if(event)visit(event);}}
    finally{lines.close();input.destroy();}
  };
  await each(e=>{if(e.runStartId&&ids.has(e.runStartId)||e.kind==='started'&&runs.some(r=>Date.parse(e.at)>=Date.parse(r.startedAt)&&Date.parse(e.at)<costRunEnd(r)))workers.add(e.runId);});
  const records:Array<{user_id:string;event:UsageEvent}>=[];
  await each(e=>{if(workers.has(e.runId))records.push({user_id:owner,event:{id:e.id,runId:e.runId,runStartId:e.runStartId,at:e.at,kind:e.kind,amountUsd:e.amountUsd,basis:e.basis}});});
  return records;
}

/** Admin routes supply database-owned IDs. Only compact totals cross the DB
 * boundary. Unsynced records replace matching IDs, so live costs never double. */
export async function loadAdminRunCosts(runs:CostRun[]):Promise<Map<string,RunCost|null>> {
  if(!runs.length)return new Map();
  const windows=runs.map(run=>({id:run.id,user_id:run.userId,started_at:run.startedAt,
    end_at:Number.isFinite(costRunEnd(run))?new Date(costRunEnd(run)).toISOString():null}));
  const liveOwners=new Set(runs.filter(r=>r.running||r.finishedAt&&Date.parse(r.finishedAt)>Date.now()-120000).map(r=>r.userId));
  const unavailable=new Set<string>();
  const live:Array<{user_id:string;event:UsageEvent}>=[];
  for(const owner of liveOwners)try{
    for(const record of await readLiveCostRecords(owner,runs.filter(r=>r.userId===owner&&(r.running||r.finishedAt&&Date.parse(r.finishedAt)>Date.now()-120000))))live.push(record);
  }catch{unavailable.add(owner);console.warn('Live run cost journal unavailable for account',owner);}
  const [rows,repairRows]=await Promise.all([
    query<{id:string;total:string;known:number;incomplete:boolean;estimated:boolean}>(ADMIN_RUN_COST_SQL,[JSON.stringify(windows),JSON.stringify(live)]),
    query<{user_id:string;run_id:string;cost_usd:string;cost_unknown:boolean;status:string}>(
      'SELECT user_id::text,run_id::text,cost_usd,cost_unknown,status FROM repair_pilot_cases WHERE run_id=ANY($1::bigint[])',[runs.map(r=>r.id)]),
  ]);
  const result=new Map<string,RunCost|null>(runs.map(run=>[run.id,null]));
  for(const row of rows){const run=runs.find(r=>r.id===row.id)!;result.set(row.id,{currency:'USD',totalUsd:Number(row.total),knownCharges:row.known,
    incomplete:run.running||!run.finishedAt||Boolean(row.incomplete),estimated:Boolean(row.estimated)});}
  mergeRepairCosts(runs,result,repairRows.map(r=>({userId:r.user_id,runId:r.run_id,costUsd:Number(r.cost_usd),unknown:r.cost_unknown,pending:!['complete','blocked','cancelled'].includes(r.status)})));
  for(const run of runs)if(unavailable.has(run.userId))result.set(run.id,{...(result.get(run.id)??{currency:'USD',totalUsd:0,knownCharges:0,estimated:false}),incomplete:true});
  return result;
}
