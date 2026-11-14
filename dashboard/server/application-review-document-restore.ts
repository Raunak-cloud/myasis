/// <reference path="../../seek-bot/src/shims.d.ts" />
import {randomUUID,createHash} from 'node:crypto';
import { browserToolCall } from '../../seek-bot/src/browser-tool-calls.js';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,relative,resolve,sep} from 'node:path';
import {getPool} from './db/index.js';
import {isAdmin} from './admin-access.js';
import {userDir,userKnowledgeDir} from './userdata.js';
import {ApplicationReviewError} from './application-reviews.js';
import {preserveDocument,verifiedDocumentPath} from '../../seek-bot/src/application-documents.js';
import {extractText} from '../../seek-bot/src/knowledge.js';
import {applicationRevision} from '../../seek-bot/src/application-review-content.js';
import type {ApplicationDocumentRestoration,PreparedApplication} from '../../seek-bot/src/application-review-types.js';

export interface ReviewDocumentRestorationPlan {
  actorUserId:string; userId:string; draftId:string; currentRevision:string; originalRevision:string;
  holdId:string; sourceRunId:string; attemptId:string; fileId:string; expectedSha256:string; reason:string;
}
const fields=['actorUserId','userId','draftId','currentRevision','originalRevision','holdId','sourceRunId','attemptId','fileId','expectedSha256','reason'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
export function documentRestorationPlan(value:unknown):ReviewDocumentRestorationPlan {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length
    ||Object.keys(value).some(key=>!fields.includes(key)))throw new ApplicationReviewError('Provide one closed, exact document restoration plan.');
  const v=value as Record<string,unknown>;
  if(fields.some(key=>typeof v[key]!=='string')||['actorUserId','userId','sourceRunId'].some(key=>!/^\d{1,19}$/.test(v[key] as string))
    ||['draftId','holdId','attemptId'].some(key=>!uuid.test(v[key] as string))
    ||['currentRevision','originalRevision','expectedSha256'].some(key=>!sha.test(v[key] as string))
    ||!/^supporting:\d{1,19}$/.test(v.fileId as string)||!(v.reason as string).trim()||(v.reason as string).length>2000)
    throw new ApplicationReviewError('Invalid operator, owner, source, document or revision identity.');
  return {...v,reason:(v.reason as string).trim()} as unknown as ReviewDocumentRestorationPlan;
}
function ownFile(owner:string,path:string):string {
  const root=realpathSync(owner),actual=realpathSync(path),part=relative(root,actual);
  if(lstatSync(owner).isSymbolicLink()||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()
    ||!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new ApplicationReviewError('The required evidence file is outside this owner.');
  return actual;
}
function parseRecord(value:unknown):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ApplicationReviewError('The owner-scoped source evidence is invalid.');
  return value as Record<string,any>;
}
function nativeProof(trace:Record<string,any>,fileId:string,name:string):{step:number;nativeUploadCompletedAt:string;nativeReadback:'confirmed'|'unavailable'} {
  if(trace.sendAudit?.attempted!==false||!Array.isArray(trace.steps))throw new ApplicationReviewError('The original attempt has no reliable no-send/native-upload audit.');
  let proof:{step:number;nativeUploadCompletedAt:string;nativeReadback:'confirmed'|'unavailable'}|undefined;
  for(const step of trace.steps){
    if(step.execution==='not-started'||step.disposition==='not-executed')continue;
    const operation=browserToolCall(step.tool,step.args??{});
    const commands=step.tool==='browser_batch'?step.args?.actions:operation.name==='browser_action'?[operation.args]:[];
    if(!Array.isArray(commands))continue;
    if(commands.some((command:any)=>command?.sends_application===true))throw new ApplicationReviewError('The source attempt contains an application-send action.');
    if(step.execution!=='started'||!step.completedAt)continue;
    let result:any;try{result=JSON.parse(step.result)}catch{continue;}
    for(const [index,command] of commands.entries()){
      if(command?.action!=='set_input_files'||!Array.isArray(command.file_ids)||!command.file_ids.includes(fileId))continue;
      let native:any=result;
      if(step.tool==='browser_batch'){
        const entry=result.results?.find((item:any)=>item.index===index);
        if(entry?.kind!=='ok'||entry.error||entry.disposition&&entry.disposition!=='completed')continue;
        try{native=JSON.parse(entry.message)}catch{continue;}
      }else if(step.disposition&&step.disposition!=='completed')continue;
      if(native.action!=='set_input_files'||!Array.isArray(native.file_ids)||!native.file_ids.includes(fileId))continue;
      const confirmed=Array.isArray(native.current?.files)&&native.current.files.includes(name)&&!native.current.invalid&&!native.current.validation;
      // Some widgets consume/remove the input before native readback. An
      // exact filename retained in the original terminal draft can corroborate
      // intended content, but cannot establish employer retention. Such a
      // repair carries an explicit mandatory future-upload obligation.
      const unavailable=native.current===null&&Array.isArray(trace.outcome?.draft?.answers)
        &&trace.outcome.draft.answers.some((answer:any)=>answer.answer===name);
      if(confirmed||unavailable)proof={step:step.step,nativeUploadCompletedAt:step.completedAt,nativeReadback:confirmed?'confirmed':'unavailable'};
    }
  }
  if(!proof||!Number.isSafeInteger(proof.step)||!Number.isFinite(Date.parse(proof.nativeUploadCompletedAt)))
    throw new ApplicationReviewError('No completed native upload selected this exact file ID and filename.');
  return proof;
}

/** Repair missing metadata on an unconfirmed, held review. Never prepares a
 * new browser application, authorizes a send, releases a hold or spends credit. */
export async function restoreReviewDocument(input:unknown):Promise<{application:PreparedApplication;alreadyCurrent:boolean}> {
  const plan=documentRestorationPlan(input),connection=await getPool().connect();
  try{
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)',[plan.userId]);
    const actor=(await connection.query<{email:string}>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL FOR SHARE',[plan.actorUserId])).rows[0];
    if(!isAdmin(actor?.email))throw new ApplicationReviewError('The operator is not an active administrator.');
    if(!(await connection.query('SELECT id FROM users WHERE id=$1 AND blocked_at IS NULL FOR SHARE',[plan.userId])).rows.length)
      throw new ApplicationReviewError('The application owner is unavailable or blocked.');
    const row=(await connection.query<{id:string;job_key:string;status:string;credit_consumed:boolean;payload:PreparedApplication}>(
      'SELECT id::text,job_key,status,credit_consumed,payload FROM application_reviews WHERE user_id=$1 AND id=$2 FOR UPDATE',[plan.userId,plan.draftId])).rows[0];
    if(!row||row.status!=='ready'||!row.credit_consumed)throw new ApplicationReviewError('The exact credited review is not ready and unconfirmed.');
    const current=row.payload;
    const hold=(await connection.query<{draft_id:string;revision:string;source_run_id:string;actor_user_id:string;job_key:string}>(
      'SELECT draft_id::text,revision,source_run_id::text,actor_user_id::text,job_key FROM application_review_operator_holds WHERE user_id=$1 AND id=$2 AND released_at IS NULL FOR UPDATE',[plan.userId,plan.holdId])).rows[0];
    if(!hold||hold.draft_id!==plan.draftId||hold.revision!==plan.originalRevision||hold.source_run_id!==plan.sourceRunId||hold.job_key!==row.job_key
      ||hold.actor_user_id!==plan.actorUserId)throw new ApplicationReviewError('The exact original operator hold is missing or no longer active.');
    const run=(await connection.query<{started_at:Date;finished_at:Date|null}>('SELECT started_at,finished_at FROM run_starts WHERE user_id=$1 AND id=$2',[plan.userId,plan.sourceRunId])).rows[0];
    if(!run)throw new ApplicationReviewError('The source run does not belong to this owner.');
    const owner=userDir(plan.userId),tracePath=resolve(owner,'traces',`attempt-${plan.attemptId}.json`);
    let rawTrace:Buffer,trace:Record<string,any>;
    try{rawTrace=readFileSync(ownFile(owner,tracePath));trace=parseRecord(JSON.parse(rawTrace.toString('utf8')));}
    catch{throw new ApplicationReviewError('The immutable owner-scoped terminal source trace is unavailable.');}
    const original=trace.outcome?.draft as PreparedApplication|undefined;
    const start=+new Date(run.started_at),end=run.finished_at?+new Date(run.finished_at):Date.now();
    if(String(trace.runStartId)!==plan.sourceRunId||trace.attemptId!==plan.attemptId||trace.outcome?.status!=='prepared'
      ||original?.id!==plan.draftId||original.revision!==plan.originalRevision||original.preparedAt!==current.preparedAt
      ||original.job?.id!==current.job?.id||(original.job?.platform??'seek')!==(current.job?.platform??'seek')
      ||String(trace.jobId)!==String(current.job?.id)||row.id!==current.id||row.job_key!==`${current.job?.platform??'seek'}:${current.job?.id}`
      ||![Date.parse(original.preparedAt),Date.parse(trace.startedAt),Date.parse(trace.savedAt)].every(time=>time>=start&&time<=end))
      throw new ApplicationReviewError('The immutable trace does not prove this exact original draft and source run.');
    if(applicationRevision(original)!==original.revision||applicationRevision(current)!==current.revision)
      throw new ApplicationReviewError('The source or current material revision integrity could not be verified.');
    // Working journals can rotate for the next run. Corroborate the source
    // event when still present; terminal attempt evidence remains authoritative.
    const journal=resolve(owner,'run-log.jsonl');
    if(existsSync(journal))for(const line of readFileSync(ownFile(owner,journal),'utf8').split('\n')){
      let event:any;try{event=JSON.parse(line)}catch{continue;}
      if(event.status==='prepared'&&event.draft?.id===original.id&&event.draft.revision===original.revision
        &&(Date.parse(event.ts)<start||Date.parse(event.ts)>end||event.draft.preparedAt!==original.preparedAt))
        throw new ApplicationReviewError('The retained source journal contradicts the immutable prepared trace.');
    }
    const file=(await connection.query<{file_name:string;kind:string;enabled:boolean}>(
      'SELECT file_name,kind,enabled FROM knowledge_items WHERE user_id=$1 AND id=$2 FOR SHARE',[plan.userId,plan.fileId.slice('supporting:'.length)])).rows[0];
    if(!file||file.kind!=='file'||!file.enabled||!file.file_name||basename(file.file_name)!==file.file_name||/[\\/\x00-\x1f]/.test(file.file_name))
      throw new ApplicationReviewError('The source must be an enabled supporting file belonging to this owner.');
    const proof=nativeProof(trace,plan.fileId,file.file_name);
    if(Date.parse(proof.nativeUploadCompletedAt)<start||Date.parse(proof.nativeUploadCompletedAt)>Date.parse(original.preparedAt))
      throw new ApplicationReviewError('The native-upload proof is outside the original preparation.');
    if(typeof process.getuid==='function'&&lstatSync(owner).uid!==process.getuid())
      throw new ApplicationReviewError('Run document restoration as the private-data service user so immutable artifacts remain readable by application workers.');
    const source=ownFile(owner,resolve(userKnowledgeDir(plan.userId),file.file_name));
    const artifact=preserveDocument(source,owner,file.file_name);
    if(artifact.sha256!==plan.expectedSha256)throw new ApplicationReviewError('The source file hash changed; no review metadata was restored.');
    const text=await extractText(verifiedDocumentPath(artifact,owner));
    if(!text.trim())throw new ApplicationReviewError('The exact supporting file has no readable full text.');
    const prior=current.documentRestorations?.find(a=>a.actorUserId===plan.actorUserId&&a.holdId===plan.holdId&&a.fileId===plan.fileId
      &&a.sha256===plan.expectedSha256&&a.sourceRunId===plan.sourceRunId&&a.originalRevision===plan.originalRevision
      &&a.previousRevision===plan.currentRevision&&a.reason===plan.reason&&a.evidence.attemptId===plan.attemptId);
    if(prior&&prior.currentRevision===current.revision&&current.coverLetter===text&&current.documents?.some(d=>d.role==='cover-letter'
      &&d.fileId===plan.fileId&&d.sha256===artifact.sha256&&d.text===text&&(proof.nativeReadback!=='unavailable'||d.requiresUpload===true))){
      await connection.query('COMMIT');return{application:current,alreadyCurrent:true};
    }
    if(current.revision!==plan.currentRevision)throw new ApplicationReviewError('The current review revision changed.');
    if(plan.currentRevision!==plan.originalRevision)throw new ApplicationReviewError('First restoration requires the unchanged original prepared version.');
    if(current.coverLetter?.trim()||original.coverLetter?.trim()||current.documents?.some(d=>d.role==='cover-letter'))
      throw new ApplicationReviewError('Restoration may only fill missing cover-letter metadata, never overwrite existing text or bindings.');
    const next:PreparedApplication={...current,coverLetter:text,documents:[...(current.documents??[]),{role:'cover-letter',provenance:'file',fileId:plan.fileId,
      name:artifact.name,sha256:artifact.sha256,bytes:artifact.bytes,text,...(proof.nativeReadback==='unavailable'?{requiresUpload:true}:{})}]};
    next.revision=applicationRevision(next);
    const at=(await connection.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
    const audit:ApplicationDocumentRestoration={id:randomUUID(),actorUserId:plan.actorUserId,restoredAt:new Date(at).toISOString(),sourceRunId:plan.sourceRunId,
      originalRevision:plan.originalRevision,previousRevision:current.revision,currentRevision:next.revision,holdId:plan.holdId,fileId:plan.fileId,
      sha256:artifact.sha256,reason:plan.reason,evidence:{attemptId:plan.attemptId,step:proof.step,nativeUploadCompletedAt:proof.nativeUploadCompletedAt,
        originalPreparedAt:original.preparedAt,traceSha256:createHash('sha256').update(rawTrace).digest('hex'),nativeReadback:proof.nativeReadback,
        selectionCompleted:true,employerRetention:'unverified'}};
    next.documentRestorations=[...(current.documentRestorations??[]),audit];
    await connection.query("UPDATE application_reviews SET payload=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND status='ready'",[plan.userId,plan.draftId,JSON.stringify(next)]);
    await connection.query('COMMIT');return{application:next,alreadyCurrent:false};
  }catch(error){await connection.query('ROLLBACK');throw error;}
  finally{connection.release();}
}
