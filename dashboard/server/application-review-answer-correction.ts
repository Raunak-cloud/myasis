import {createHash} from 'node:crypto';
import { browserToolCall } from '../../shared/browser-tool-calls.mjs';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {getPool} from './db/index.js';
import {isAdmin} from './admin-access.js';
import {ApplicationReviewError} from './application-reviews.js';
import {userDir} from './userdata.js';
import {applicationRevision} from '../../seek-bot/src/application-review-content.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

export interface HeldAnswerCorrectionPlan {
  operationId:string; actorUserId:string; userId:string; draftId:string; holdId:string;
  originalRevision:string; currentRevision:string; sourceRunId:string; attemptId:string;
  expectedTraceSha256:string; reason:string; evidence:string;
  changes:Array<{question:string;before:string;after:string}>;
}
const fields=['operationId','actorUserId','userId','draftId','holdId','originalRevision','currentRevision','sourceRunId','attemptId','expectedTraceSha256','reason','evidence','changes'];
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
const normal=(value:string)=>value.replace(/\s+/g,' ').trim();
export function heldAnswerCorrectionPlan(value:unknown):HeldAnswerCorrectionPlan {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length
    ||Object.keys(value).some(key=>!fields.includes(key)))throw new ApplicationReviewError('Provide one closed held-answer correction plan.');
  const v=value as Record<string,unknown>;
  if(fields.filter(key=>key!=='changes').some(key=>typeof v[key]!=='string')
    ||['actorUserId','userId','sourceRunId'].some(key=>!/^\d{1,19}$/.test(v[key] as string))
    ||['operationId','draftId','holdId','attemptId'].some(key=>!uuid.test(v[key] as string))
    ||['originalRevision','currentRevision','expectedTraceSha256'].some(key=>!sha.test(v[key] as string))
    ||['reason','evidence'].some(key=>!(v[key] as string).trim()||(v[key] as string).length>2000)
    ||!Array.isArray(v.changes)||!v.changes.length||v.changes.length>20)throw new ApplicationReviewError('Invalid correction identity, evidence or changes.');
  for(const item of v.changes){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==3
      ||Object.keys(item).some(key=>!['question','before','after'].includes(key))
      ||['question','before','after'].some(key=>typeof item[key]!=='string'||!item[key].trim()||item[key].length>50_000)
      ||normal(item.before)===normal(item.after))throw new ApplicationReviewError('Each correction needs one exact question, previous answer and different nonempty answer.');
  }
  if(new Set(v.changes.map(item=>item.question)).size!==v.changes.length)throw new ApplicationReviewError('A question may appear only once in a correction.');
  return {operationId:v.operationId as string,actorUserId:v.actorUserId as string,userId:v.userId as string,draftId:v.draftId as string,holdId:v.holdId as string,
    originalRevision:v.originalRevision as string,currentRevision:v.currentRevision as string,sourceRunId:v.sourceRunId as string,attemptId:v.attemptId as string,
    expectedTraceSha256:v.expectedTraceSha256 as string,reason:(v.reason as string).trim(),evidence:(v.evidence as string).trim(),
    changes:v.changes.map(item=>({question:item.question,before:item.before,after:item.after}))};
}
function sourceTrace(owner:string,attemptId:string):{trace:any;sha256:string} {
  const directory=resolve(owner),path=resolve(directory,'traces',`attempt-${attemptId}.json`);
  try{
    if(realpathSync(directory)!==directory||realpathSync(path)!==path)throw Error('Outside owner');
    const file=lstatSync(path);
    if(!file.isFile()||file.isSymbolicLink()||file.size>32*1024*1024)throw Error('Invalid trace');
    const bytes=readFileSync(path),trace=JSON.parse(bytes.toString('utf8'));
    if(bytes.length>32*1024*1024||!trace||typeof trace!=='object'||Array.isArray(trace))throw Error('Invalid trace');
    return{trace,sha256:createHash('sha256').update(bytes).digest('hex')};
  }catch{throw new ApplicationReviewError('The immutable owner-scoped prepared source trace is unavailable.');}
}
/** This proof is for correcting an existing held Semi auto draft only. It is
 * never retry/send permission and does not broaden the repair retry predicate. */
function preparedNoSend(trace:any,start:number,end:number):boolean {
  if(trace.mode!=='prepare'||trace.outcome?.status!=='prepared'||trace.sendAudit?.attempted!==false||!Array.isArray(trace.steps)||!trace.steps.length)return false;
  for(const step of trace.steps){
    if(!step||!Number.isFinite(Date.parse(step.completedAt))||Date.parse(step.completedAt)<start||Date.parse(step.completedAt)>end)return false;
    if(step.execution==='not-started'||step.disposition==='not-executed')continue;
    if(step.execution!=='started'||step.tool==='send_email_application'||step.tool==='finish'&&step.args?.status==='applied')return false;
    const operation=browserToolCall(step.tool,step.args??{});
    const commands=step.tool==='browser_batch'?step.args?.actions:operation.name==='browser_action'?[operation.args]:[];
    if(!Array.isArray(commands))return false;
    for(const command of commands){
      if(!command||command.sends_application===true||command.action==='mouse_click'
        ||command.action==='script'&&command.script_intent!=='inspect'
        ||['click','press'].includes(command.action)&&command.sends_application!==false
        ||command.target_mode==='coordinates'||command.x!==undefined||command.y!==undefined)return false;
    }
  }
  return true;
}

/** Explicit operator correction of unconfirmed answers. Keep the safety hold
 * until a separate human resolution; candidate approval is never manufactured. */
export async function correctHeldReviewAnswers(input:unknown):Promise<{application:PreparedApplication;auditId:string;alreadyCurrent:boolean}> {
  const plan=heldAnswerCorrectionPlan(input),connection=await getPool().connect();
  try{
    await connection.query('BEGIN');await connection.query("SET LOCAL lock_timeout='5s'");
    // Deterministic user locks also prevent a new run's FK insert from passing
    // the idle-owner check while this correction is committed.
    const users=(await connection.query<{id:string;email:string;blocked_at:Date|null}>(
      'SELECT id::text,email,blocked_at FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[[...new Set([plan.actorUserId,plan.userId])]])).rows;
    const actor=users.find(user=>user.id===plan.actorUserId),owner=users.find(user=>user.id===plan.userId);
    if(!actor||actor.blocked_at||!isAdmin(actor.email))throw new ApplicationReviewError('The operator is not an active administrator.');
    if(!owner||owner.blocked_at)throw new ApplicationReviewError('The application owner is unavailable or blocked.');
    // Fail rather than wait with user locks if another review writer already
    // owns the advisory lock; this avoids reversing its normal lock order.
    if(!(await connection.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',[plan.userId])).rows[0]?.locked)
      throw new ApplicationReviewError('Another account operation is active. Retry the exact plan after it finishes.');
    if((await connection.query('SELECT id FROM run_starts WHERE user_id=$1 AND finished_at IS NULL LIMIT 1',[plan.userId])).rows.length)
      throw new ApplicationReviewError('Wait until every application run for this owner has finished.');
    const run=(await connection.query<{started_at:Date;finished_at:Date|null}>(
      'SELECT started_at,finished_at FROM run_starts WHERE user_id=$1 AND id=$2 FOR SHARE',[plan.userId,plan.sourceRunId])).rows[0];
    if(!run?.finished_at)throw new ApplicationReviewError('The completed source run does not belong to this owner.');
    const row=(await connection.query<{id:string;job_key:string;status:string;credit_consumed:boolean;payload:PreparedApplication}>(
      'SELECT id::text,job_key,status,credit_consumed,payload FROM application_reviews WHERE user_id=$1 AND id=$2 FOR UPDATE',[plan.userId,plan.draftId])).rows[0];
    if(!row||row.status!=='ready'||!row.credit_consumed)throw new ApplicationReviewError('The exact imported, credited draft must be ready and unconfirmed.');
    const hold=(await connection.query<{draft_id:string;revision:string;job_key:string;source_run_id:string;actor_user_id:string}>(
      'SELECT draft_id::text,revision,job_key,source_run_id::text,actor_user_id::text FROM application_review_operator_holds WHERE user_id=$1 AND id=$2 AND released_at IS NULL FOR UPDATE',[plan.userId,plan.holdId])).rows[0];
    if(!hold||hold.draft_id!==plan.draftId||hold.revision!==plan.originalRevision||hold.job_key!==row.job_key
      ||hold.source_run_id!==plan.sourceRunId||hold.actor_user_id!==plan.actorUserId)throw new ApplicationReviewError('The exact original operator hold is missing or no longer active.');
    const current=row.payload,{trace,sha256}=sourceTrace(userDir(plan.userId),plan.attemptId),original=trace.outcome?.draft as PreparedApplication|undefined;
    const start=+new Date(run.started_at),end=+new Date(run.finished_at);
    if(sha256!==plan.expectedTraceSha256||String(trace.runStartId)!==plan.sourceRunId||trace.attemptId!==plan.attemptId
      ||!original||original.id!==plan.draftId||original.revision!==plan.originalRevision||original.preparedAt!==current.preparedAt
      ||original.job?.id!==current.job?.id||(original.job?.platform??'seek')!==(current.job?.platform??'seek')
      ||trace.jobId!==current.job?.id||trace.job?.id!==current.job?.id||trace.job?.platform!==(current.job?.platform??'seek')
      ||row.id!==current.id||row.job_key!==`${current.job?.platform??'seek'}:${current.job?.id}`
      ||![Date.parse(original.preparedAt),Date.parse(trace.startedAt),Date.parse(trace.savedAt)].every(at=>at>=start&&at<=end)
      ||!preparedNoSend(trace,start,end))throw new ApplicationReviewError('The immutable trace does not prove this exact prepared draft with no application send.');
    if(applicationRevision(original)!==original.revision||applicationRevision(current)!==current.revision)
      throw new ApplicationReviewError('The original or current material revision integrity is invalid.');
    if((await connection.query('SELECT 1 FROM applications WHERE user_id=$1 AND platform=$2 AND job_id=$3 LIMIT 1',
      [plan.userId,current.job.platform??'seek',current.job.id])).rows.length)throw new ApplicationReviewError('An application or uncertain send already exists for this owner and job.');
    const previous=(await connection.query<{plan:unknown;current_revision:string}>(
      'SELECT plan,current_revision FROM application_review_operator_answer_revisions WHERE user_id=$1 AND id=$2',[plan.userId,plan.operationId])).rows[0];
    if(previous){
      if(JSON.stringify(heldAnswerCorrectionPlan(previous.plan))!==JSON.stringify(plan)||current.revision!==previous.current_revision)
        throw new ApplicationReviewError('This operation ID has different evidence or the corrected draft changed.');
      await connection.query('COMMIT');return{application:current,auditId:plan.operationId,alreadyCurrent:true};
    }
    if(current.revision!==plan.currentRevision)throw new ApplicationReviewError('The selected current draft revision changed.');
    for(const change of plan.changes){
      const matches=current.answers.filter(answer=>answer.question===change.question);
      if(matches.length!==1||matches[0].answer!==change.before)throw new ApplicationReviewError('An exact answer selection changed or is ambiguous.');
      const material=[current.coverLetter,current.resume,...(current.documents??[]).flatMap(document=>[document.text,document.name])].filter((value):value is string=>Boolean(value));
      if(material.some(value=>normal(value)===normal(change.before)))throw new ApplicationReviewError('Use the document or cover-letter workflow for an answer bound to approved material.');
    }
    const changes=new Map(plan.changes.map(change=>[change.question,change.after]));
    const next:PreparedApplication={...current,answers:current.answers.map(answer=>changes.has(answer.question)?{...answer,answer:changes.get(answer.question)!}:answer)};
    next.revision=applicationRevision(next);
    if(next.revision===current.revision)throw new ApplicationReviewError('The correction does not change reviewed content.');
    const updated=await connection.query(`UPDATE application_reviews SET payload=$4,updated_at=clock_timestamp()
      WHERE user_id=$1 AND id=$2 AND status='ready' AND credit_consumed AND payload->>'revision'=$3 RETURNING id`,
      [plan.userId,plan.draftId,plan.currentRevision,JSON.stringify(next)]);
    if(updated.rows.length!==1)throw new ApplicationReviewError('The draft changed before its exact correction could be saved.');
    await connection.query(`INSERT INTO application_review_operator_answer_revisions
      (id,user_id,hold_id,draft_id,actor_user_id,source_run_id,original_revision,previous_revision,current_revision,source_trace_sha256,plan)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[plan.operationId,plan.userId,plan.holdId,plan.draftId,plan.actorUserId,plan.sourceRunId,
      plan.originalRevision,current.revision,next.revision,sha256,JSON.stringify(plan)]);
    await connection.query('COMMIT');return{application:next,auditId:plan.operationId,alreadyCurrent:false};
  }catch(error){await connection.query('ROLLBACK');throw error;}
  finally{connection.release();}
}
