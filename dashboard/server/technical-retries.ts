import { existsSync, readFileSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from './db/index.js';
import { claimApplicationReviews, releaseApplicationReviews } from './application-reviews.js';
import { applicationKeys, sameApplication } from '../../seek-bot/src/application-identity.js';
import { listingAgeDays, passesListingAge } from '../../seek-bot/src/listing-age.js';
import { matchingExcludedCompany } from '../../seek-bot/src/company-match.js';
import { isExternalApplicationUrl } from '../../seek-bot/src/job-board-url.js';
import { TECHNICAL_RETRY_FILE, technicalFailure, type TechnicalAttempt, type TechnicalRetryCandidate } from '../../seek-bot/src/technical-retry-types.js';
import type { JobListing, AppliedRecord } from '../../seek-bot/src/types.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';

interface RetryPayload extends TechnicalAttempt {reason:string;failedAt:string;keys:string[]}
interface RetryRow {job_key:string;payload:RetryPayload;status:string;failed_at:Date|string;last_run_id:string|null}
export interface TechnicalRetryContext {platforms:string[];maxAgeDays:number;excludedCompanies:string[];external:boolean;scope:string;deadlineAt:number;directory:string;creditsRemaining?:number;externalRemaining?:number}

function validJob(job:JobListing|undefined):job is JobListing {
  if(!job || !job.id || !job.title || !job.company || !job.platform)return false;
  try{return new URL(job.url).protocol==='https:';}catch{return false;}
}
const keyOf=(job:JobListing)=>`${job.platform ?? 'seek'}:${job.id}`;
const externalJob=(job:JobListing)=>job.applicationMode==='external' || Boolean(job.applicationUrl && isExternalApplicationUrl(job.applicationUrl))
  || !['seek','indeed','adzuna'].includes(job.platform??'seek');
function datedJob(job:JobListing,at:string):JobListing {
  const age=listingAgeDays(job,Date.parse(at));
  return {...job,...(age!==undefined && !/^\d{4}-\d\d-\d\d/.test(job.listedAt??'')
    ? {listedAt:new Date(Date.parse(at)-age*86400000).toISOString()}:{}),source:'search'};
}
function traceFor(dir:string,job:JobListing):Record<string,any>|undefined {
  const file=resolve(dir,'traces',`${job.id}.json`),part=relative(resolve(dir,'traces'),file);
  if(!part || part==='..' || part.startsWith('..'+sep) || !existsSync(file))return;
  const stat=lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>32*1024*1024)return;
  try{
    const trace=JSON.parse(readFileSync(file,'utf8'));
    if(trace.jobId===job.id && trace.job?.platform===job.platform && trace.job?.url===job.url)return trace;
  }catch{ /* A damaged or incomplete trace is not retry evidence. */ }
}

/** The event belongs to a real run of this owner; matching and applying remain separate. */
export async function rememberTechnicalAttempt(userId:string,event:Record<string,any>,dir:string):Promise<void> {
  const attempt=event.technicalAttempt as TechnicalAttempt|undefined;
  if(!attempt || !validJob(attempt.job) || !/^\d+$/.test(attempt.runId) || !Number.isFinite(Date.parse(event.ts)))return;
  const [run]=await query('SELECT id FROM run_starts WHERE id=$1 AND user_id=$2',[attempt.runId,userId]);
  if(!run)return;
  const job=datedJob(attempt.job,event.ts),key=keyOf(job);
  const trace=traceFor(dir,job);
  const possibleSend=event.submitPressed===true || (String(trace?.runStartId)===attempt.runId && trace?.sendAudit?.attempted===true);
  const retry=technicalFailure(event) && !possibleSend;
  const state=possibleSend?'held':retry?'pending':'closed';
  const payload:RetryPayload={...attempt,job,reason:String(event.error??event.reason??event.status),failedAt:event.ts,keys:applicationKeys(job)};
  // A successful/answered/dismissed attempt closes an existing retry; it does not create a new backlog entry.
  if(!retry && !possibleSend){
    await query(`UPDATE technical_application_retries SET status='closed',updated_at=$3
      WHERE user_id=$1 AND job_key=$2 AND updated_at<=$3::timestamptz`,[userId,key,event.ts]);return;
  }
  if(!job.fitReview && !attempt.approval)return;
  await query(`INSERT INTO technical_application_retries(user_id,job_key,payload,status,failed_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(user_id,job_key) DO UPDATE
    SET payload=EXCLUDED.payload,status=EXCLUDED.status,failed_at=EXCLUDED.failed_at,updated_at=EXCLUDED.updated_at
    WHERE technical_application_retries.updated_at<=EXCLUDED.updated_at`,[userId,key,JSON.stringify(payload),state,event.ts]);
}

export async function importTechnicalAttemptJournal(userId:string,dir:string):Promise<void> {
  const file=resolve(dir,'run-log.jsonl');if(!existsSync(file))return;
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line.trim())continue;
    let event:Record<string,any>;try{event=JSON.parse(line);}catch{continue;}
    if(event.technicalAttempt)await rememberTechnicalAttempt(userId,event,dir);
  }
}

/** Recover earlier failed saved applications and retained ordinary attempt traces.
 * Missing send evidence is left for the existing explicit retry path. */
async function backfillTechnicalRetries(userId:string,dir:string):Promise<void> {
  const drafts=await query<{payload:PreparedApplication}>("SELECT payload FROM application_reviews WHERE user_id=$1 AND status='failed'",[userId]);
  const events=await query<{job_id:string;url:string;platform:string}>(`SELECT DISTINCT ON(e.job_id) e.job_id,e.url,m.payload->>'platform' platform
    FROM run_events e JOIN completed_job_reviews m ON m.user_id=e.user_id AND m.payload->>'jobId'=e.job_id
    WHERE e.user_id=$1 AND e.status IN ('error','skipped','needs-human') AND m.payload->'assessment'->>'decision'='apply'
    ORDER BY e.job_id,e.ts DESC`,[userId]);
  const jobs=[...drafts.map(row=>({job:row.payload.job,draft:row.payload})),...events.filter(e=>e.url&&e.platform).map(e=>({job:{id:e.job_id,url:e.url,platform:e.platform} as JobListing,draft:undefined}))];
  for(const item of jobs){
    const trace=traceFor(dir,item.job);
    if(!trace || trace.sendAudit?.attempted!==false || !trace.outcome || !validJob(trace.job)
      || !Number.isFinite(Date.parse(trace.savedAt)) || !/^\d+$/.test(String(trace.runStartId)))continue;
    if(item.draft && (trace.mode!=='approved' || trace.sendAudit.approvedRevision!==item.draft.revision))continue;
    const outcome={...trace.outcome,submitPressed:false};
    if(outcome.status==='error')outcome.error=outcome.reason;
    if(!technicalFailure(outcome))continue;
    await rememberTechnicalAttempt(userId,{...outcome,ts:trace.savedAt,technicalAttempt:{job:trace.job,runId:String(trace.runStartId),
      ...(item.draft?{approval:{id:item.draft.id,revision:item.draft.revision}}:{})}},dir);
  }
}

export async function exportTechnicalRetries(userId:string,dir:string):Promise<void> {
  await importTechnicalAttemptJournal(userId,dir);
  await backfillTechnicalRetries(userId,dir);
  const rows=await query<RetryRow>("SELECT job_key,payload,status,failed_at,last_run_id::text FROM technical_application_retries WHERE user_id=$1 AND status<>'closed'",[userId]);
  const file=resolve(dir,TECHNICAL_RETRY_FILE),temp=`${file}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify({keys:[...new Set(rows.flatMap(row=>row.payload.keys))]}),{mode:0o600});renameSync(temp,file);
}

async function ownerApplications(userId:string):Promise<AppliedRecord[]> {
  const rows=await query<Record<string,any>>('SELECT job_id,platform,title,company,location,url,application_url,confirmation_status FROM applications WHERE user_id=$1',[userId]);
  return rows.map(row=>({...row,jobId:row.job_id,applicationUrl:row.application_url,confirmationStatus:row.confirmation_status})) as AppliedRecord[];
}

/** Claim one bounded fallback batch, after the worker has exhausted its online reviews. */
export async function claimTechnicalRetries(userId:string,runId:string,count:number,context:TechnicalRetryContext):Promise<TechnicalRetryCandidate[]> {
  const [run]=await query('SELECT id FROM run_starts WHERE id=$1 AND user_id=$2 AND finished_at IS NULL',[runId,userId]);
  if(!run || !Number.isInteger(count) || count<1 || Date.now()>=context.deadlineAt)return [];
  const [rows,applications,holds]=await Promise.all([
    query<RetryRow>(`SELECT job_key,payload,status,failed_at,last_run_id::text FROM technical_application_retries
      WHERE user_id=$1 AND status='pending' AND (last_run_id IS NULL OR last_run_id<>$2)
      ORDER BY attempted_at NULLS FIRST,failed_at,job_key`,[userId,runId]),
    ownerApplications(userId),
    query<{job:JobListing}>("SELECT job FROM application_review_operator_holds WHERE user_id=$1 AND released_at IS NULL",[userId]),
  ]);
  const claimed:TechnicalRetryCandidate[]=[],keys=new Set<string>();
  let credits=context.creditsRemaining??Infinity;
  rows.sort((a,b)=>Number(externalJob(a.payload.job))-Number(externalJob(b.payload.job)));
  for(const row of rows){
    if(claimed.length>=count || Date.now()>=context.deadlineAt)break;
    const job=row.payload.job;
    if(!row.payload.approval && credits<=0)continue;
    const latest=traceFor(context.directory,job);
    if(latest && String(latest.runStartId)!==row.payload.runId && (latest.sendAudit?.attempted!==false || !latest.outcome)){
      await query("UPDATE technical_application_retries SET status='held' WHERE user_id=$1 AND job_key=$2 AND status='pending'",[userId,row.job_key]);continue;
    }
    if(!validJob(job) || !context.platforms.includes(job.platform!) || !passesListingAge(job,context.maxAgeDays)
      || matchingExcludedCompany(job.company,context.excludedCompanies)
      || externalJob(job)&&(!context.external || (context.externalRemaining??Infinity)<=0)
      || context.scope!=='all'&&job.applicationMode&&job.applicationMode!=='unknown'&&job.applicationMode!==context.scope)continue;
    const aliases=applicationKeys(job);
    if(aliases.some(key=>keys.has(key)) || applications.some(record=>sameApplication(record,job))
      || holds.some(row=>applicationKeys(row.job).some(key=>aliases.includes(key))))continue;
    const saved=await query(`UPDATE technical_application_retries SET status='leased',last_run_id=$3,attempted_at=now(),updated_at=date_trunc('milliseconds',now())
      WHERE user_id=$1 AND job_key=$2 AND status='pending' AND failed_at=$4::timestamptz
      AND (last_run_id IS NULL OR last_run_id<>$3) RETURNING job_key`,[userId,row.job_key,runId,row.failed_at]);
    if(!saved.length)continue;
    let approval:PreparedApplication|undefined;
    if(row.payload.approval){
      try{[approval]=await claimApplicationReviews(userId,[{...row.payload.approval,retry:true}]);}
      catch{await query("UPDATE technical_application_retries SET status='pending' WHERE user_id=$1 AND job_key=$2 AND last_run_id=$3",[userId,row.job_key,runId]);continue;}
    }else{
      const pending=await query("SELECT 1 FROM application_reviews WHERE user_id=$1 AND job_key=$2 AND status IN ('ready','approved','failed')",[userId,row.job_key]);
      if(pending.length){await query("UPDATE technical_application_retries SET status='pending' WHERE user_id=$1 AND job_key=$2 AND last_run_id=$3",[userId,row.job_key,runId]);continue;}
    }
    for(const key of aliases)keys.add(key);
    if(!approval)credits--;
    claimed.push({key:row.job_key,job,reason:row.payload.reason,failedAt:new Date(row.failed_at).toISOString(),...(approval?{approval}:{})});
  }
  return claimed;
}

/** Never-started leases return to the backlog. Interrupted sends remain held. */
export async function finishTechnicalRetryLeases(userId:string,runId:string,dir:string):Promise<void> {
  const rows=await query<RetryRow>("SELECT job_key,payload,status,failed_at,last_run_id::text FROM technical_application_retries WHERE user_id=$1 AND last_run_id=$2 AND status='leased'",[userId,runId]);
  for(const row of rows){
    const trace=traceFor(dir,row.payload.job);
    const started=String(trace?.runStartId)===runId;
    if(started && trace?.outcome && trace.sendAudit?.attempted===false){
      const outcome={...trace.outcome,submitPressed:false};if(outcome.status==='error')outcome.error=outcome.reason;
      if(technicalFailure(outcome)){
        await rememberTechnicalAttempt(userId,{...outcome,ts:trace.savedAt,technicalAttempt:{...row.payload,runId}},dir);continue;
      }
    }
    await query("UPDATE technical_application_retries SET status=$4 WHERE user_id=$1 AND job_key=$2 AND last_run_id=$3 AND status='leased'",[userId,row.job_key,runId,started?'held':'pending']);
    if(!started && row.payload.approval)await releaseApplicationReviews(userId,[row.payload.approval.id]);
  }
}
