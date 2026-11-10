import {randomUUID} from 'node:crypto';
import {query,one} from './db/index.js';
import {isAdmin} from './billing.js';
import {runner} from './runner.js';
import {bonusRunOptions} from './bonus-run-policy.js';
import type {BonusRun,BonusRunOptions} from '../src/bonus-run.js';
import type {PoolClient} from 'pg';

interface BonusRow {
 id:string;user_id:string;started_by:string;max_applications:number;application_mode:BonusRunOptions['applicationMode'];
 message:string;salary_discount_percent:string;status:BonusRun['status'];created_at:Date;claimed_at:Date|null;
 run_start_id:string|null;finished_at:Date|null;
}
export async function createBonusRun(userId:string,actorId:string,raw:unknown,id=randomUUID()):Promise<string> {
 const options=bonusRunOptions(raw);
 const actor=await one<{email:string}>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL',[actorId]);
 if(!isAdmin(actor?.email))throw Error('An active administrator is required.');
 const owner=await one('SELECT id FROM users WHERE id=$1 AND blocked_at IS NULL',[userId]);
 if(!owner)throw Error('This account is unavailable.');
 if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id))throw Error('Invalid bonus run request.');
 const rows=await query<{id:string}>(`INSERT INTO bonus_runs(id,user_id,started_by,max_applications,application_mode,message,salary_discount_percent)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
  [id,userId,actorId,options.maxApplications,options.applicationMode,options.message,options.salaryDiscountPercent]);
 if(!rows.length){
  const existing=await one<BonusRow>('SELECT * FROM bonus_runs WHERE id=$1 AND user_id=$2 AND started_by=$3',[id,userId,actorId]);
  if(!existing||existing.max_applications!==options.maxApplications||existing.application_mode!==options.applicationMode
   ||existing.message!==options.message||Number(existing.salary_discount_percent)!==options.salaryDiscountPercent)throw Error('The bonus run request has changed.');
 }
 return id;
}
export async function bonusRunForStart(id:string,userId:string,actorId:string|undefined|null):Promise<BonusRow> {
 const row=await one<BonusRow & {email:string}>(`SELECT b.*,b.user_id::text,b.started_by::text,u.email FROM bonus_runs b
  JOIN users u ON u.id=b.started_by AND u.blocked_at IS NULL
  WHERE b.id=$1 AND b.user_id=$2 AND b.started_by=$3 AND b.status='starting' AND b.run_start_id IS NULL`,[id,userId,actorId]);
 if(!row||!isAdmin(row.email))throw Error('This bonus run has no valid administrator authorization.');
 return row;
}
export async function bindBonusRun(id:string,userId:string,runId:string):Promise<void> {
 const rows=await query(`UPDATE bonus_runs SET status='running',run_start_id=$3 WHERE id=$1 AND user_id=$2 AND status='starting' AND run_start_id IS NULL RETURNING id`,[id,userId,runId]);
 if(!rows.length)throw Error('The bonus run is no longer available to start.');
}
/** Run transport cannot grant its own exemption or relax a different preference. */
export async function bonusRunEnvironment(userId:string,runId:string|undefined|null,settings:Record<string,string>):Promise<Record<string,string>> {
 if(!settings.BONUS_RUN_ID)return {BONUS_RUN_ID:''};
 if(!runId)throw Error('A bonus run requires its recorded administrator authorization.');
 const row=await one<{email:string;max_applications:number;operator_options:{bonusRunId?:string;complimentary?:boolean;minimumSalary?:string}}>(`SELECT actor.email,b.max_applications,r.operator_options
  FROM bonus_runs b JOIN run_starts r ON r.id=b.run_start_id AND r.user_id=b.user_id
  JOIN users actor ON actor.id=b.started_by AND actor.blocked_at IS NULL
  WHERE b.id=$1 AND b.user_id=$2 AND r.id=$3 AND b.status='running' AND r.finished_at IS NULL
   AND r.trigger='admin' AND r.mode='live' AND r.started_by=b.started_by`,[settings.BONUS_RUN_ID,userId,runId]);
 if(!row||!isAdmin(row.email)||row.operator_options?.bonusRunId!==settings.BONUS_RUN_ID||row.operator_options?.complimentary!==true
  ||String(row.max_applications)!==settings.MAX_APPS_PER_RUN||row.operator_options.minimumSalary!==settings.MIN_SALARY)
  throw Error('This bonus run has no matching administrator authorization.');
 return {BONUS_RUN_ID:settings.BONUS_RUN_ID};
}
/** The source run is supplied by its worker's parent, never by a model draft.
 * A later admin/account status change cannot bill a promised complimentary draft. */
export async function complimentaryReviewRun(client:Pick<PoolClient,'query'>,userId:string,sourceRunId:string|undefined,preparedAt:string):Promise<{id:string;max_applications:number}|null> {
 if(!sourceRunId)return null;
 const result=await client.query<{id:string;max_applications:number}>(`SELECT b.id,b.max_applications FROM bonus_runs b JOIN run_starts r ON r.id=b.run_start_id AND r.user_id=b.user_id
  WHERE b.user_id=$1 AND r.id=$2 AND r.trigger='admin' AND r.started_by=b.started_by
   AND r.operator_options->>'bonusRunId'=b.id::text AND r.operator_options->>'complimentary'='true'
   AND r.started_at<=$3::timestamptz AND (r.finished_at IS NULL OR $3::timestamptz<=r.finished_at)`,[userId,sourceRunId,preparedAt]);
 return result.rows[0]??null;
}
export async function listBonusRuns(userId:string):Promise<BonusRun[]> {
 const rows=await query<BonusRow & {started_at:Date|null;run_finished_at:Date|null;stopped:boolean|null;exit_code:number|null;applied:number|null;prepared:string}>(`SELECT b.*,r.started_at,r.finished_at AS run_finished_at,r.stopped,r.exit_code,r.applied,
  (SELECT count(*) FROM application_reviews a WHERE a.user_id=b.user_id AND a.payload->>'bonusRunId'=b.id::text)::text AS prepared
  FROM bonus_runs b LEFT JOIN run_starts r ON r.id=b.run_start_id AND r.user_id=b.user_id
  WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 10`,[userId]);
 return rows.map(row=>({id:row.id,maxApplications:row.max_applications,applicationMode:row.application_mode,message:row.message,
  salaryDiscountPercent:Number(row.salary_discount_percent),status:row.run_finished_at?row.stopped?'stopped':Number(row.exit_code??0)!==0?'error':'completed':row.status,
  createdAt:row.created_at.toISOString(),startedAt:row.started_at?.toISOString()??null,finishedAt:(row.run_finished_at??row.finished_at)?.toISOString()??null,
  runId:row.run_start_id,applied:row.applied??0,prepared:Number(row.prepared)}));
}
export async function cancelBonusRun(id:string,userId:string):Promise<void> {
 const rows=await query("UPDATE bonus_runs SET status='stopped',finished_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','starting') AND run_start_id IS NULL RETURNING id",[id,userId]);
 if(rows.length)return;
 const row=await one<BonusRow>('SELECT * FROM bonus_runs WHERE id=$1 AND user_id=$2',[id,userId]);
 if(!row)throw Error('Bonus run not found.');
 if(row.status==='running'&&row.run_start_id) {
  const current=await one<{id:string}>('SELECT id::text FROM run_starts WHERE id=$1 AND user_id=$2 AND finished_at IS NULL',[row.run_start_id,userId]);
  if(current && runner.runIdFor(userId)===row.run_start_id)await runner.stop(userId);
 }
}
let dispatching=false,timer:ReturnType<typeof setInterval>|undefined;
export async function dispatchBonusRuns():Promise<void> {
 if(dispatching)return;dispatching=true;
 try {
  // Reclaim only work that never bound a worker. A bound run is never replayed.
  const stale=await query<{id:string;user_id:string}>("SELECT id,user_id::text FROM bonus_runs WHERE status='starting' AND run_start_id IS NULL AND claimed_at<now()-interval '5 minutes'");
  for(const item of stale)if(!runner.inUse(item.user_id))await query("UPDATE bonus_runs SET status='queued',claimed_at=NULL WHERE id=$1 AND status='starting' AND run_start_id IS NULL",[item.id]);
  await query(`UPDATE bonus_runs b SET status=CASE WHEN r.stopped THEN 'stopped' WHEN r.exit_code<>0 THEN 'error' ELSE 'completed' END,finished_at=r.finished_at
   FROM run_starts r WHERE b.run_start_id=r.id AND b.status='running' AND r.finished_at IS NOT NULL`);
  const pending=await query<BonusRow & {email:string}>(`SELECT b.*,b.user_id::text,b.started_by::text,u.email FROM bonus_runs b JOIN users u ON u.id=b.user_id AND u.blocked_at IS NULL WHERE b.status='queued' ORDER BY b.created_at LIMIT 25`);
  for(const item of pending){
   if(runner.inUse(item.user_id))continue;
   const claim=await query("UPDATE bonus_runs SET status='starting',claimed_at=now() WHERE id=$1 AND status='queued' RETURNING id",[item.id]);
   if(!claim.length)continue;
   try{
    const {startRun}=await import('./start-run.js');
    const result=await startRun({userId:item.user_id,email:item.email,mode:'live',trigger:'admin',startedBy:item.started_by,applicationMode:item.application_mode,bonusRunId:item.id});
    if(!result.ok)await query("UPDATE bonus_runs SET status=$2,failure_detail=$3,finished_at=CASE WHEN $2='error' THEN now() ELSE NULL END WHERE id=$1 AND run_start_id IS NULL",[item.id,result.status===409||result.status===503?'queued':'error',result.error]);
   }catch(error){await query("UPDATE bonus_runs SET status='error',finished_at=now(),failure_detail=$2 WHERE id=$1 AND run_start_id IS NULL",[item.id,String((error as Error).message)]);}
  }
 }finally{dispatching=false;}
}
export function startBonusRunDispatcher(){
 if(timer)return;
 const tick=()=>void dispatchBonusRuns().catch(error=>console.error('Bonus run dispatch failed:',(error as Error).message));
 timer=setInterval(tick,15_000);timer.unref();tick();
}
