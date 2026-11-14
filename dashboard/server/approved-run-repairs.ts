import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import { browserToolCall } from '../../seek-bot/src/browser-tool-calls.js';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {query} from './db/index.js';
import {userDir} from './userdata.js';
import {applicationKeys} from '../../seek-bot/src/application-identity.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

/** Automated selection is stricter than a manual Retry: require the immutable
 * approved attempt AND its durable no-send record. Do not weaken repair-safety. */
export function approvedRepairProof(trace:any,state:any,revision:string):boolean {
 if(!trace||!state||trace.mode!=='approved'||!['skipped','error'].includes(trace.outcome?.status)
  ||trace.sendAudit?.attempted!==false||trace.sendAudit.approvedRevision!==revision
  ||!['finished','paused'].includes(state.status)||state.pending||state.submissionAttempted!==false
  ||state.scope?.mode!=='approved'||String(state.scope.runId)!==String(trace.runStartId)||state.scope.jobId!==trace.jobId
  ||!Array.isArray(trace.steps)||!trace.steps.length)return false;
 if(state.investigations?.some((i:any)=>i.kind==='submission'&&i.status!=='resolved'))return false;
 for(const step of trace.steps){
  if(!step.completedAt){
   if(step.label==='Recovery checkpoint response rejected'&&!step.execution&&!step.startedAt&&step.tool==='finish')continue;
   return false;
  }
  if(step.execution==='not-started'||step.disposition==='not-executed')continue;
  if(step.tool==='send_email_application')return false;
  if(String(step.tool).startsWith('helper_'))return false;
  const operation=browserToolCall(step.tool,step.args??{});
  const commands=step.tool==='browser_batch'?step.args?.actions:operation.name==='browser_action'?[operation.args]:[];
  if(!Array.isArray(commands))return false;
  for(const c of commands){
   if(!c||['script','press','mouse_click'].includes(c.action))return false;
   if(c.target_mode!==undefined&&!['ref','selector','locator','page'].includes(c.target_mode))return false;
   if(c.action!=='scroll'&&c.target_mode===undefined&&(c.x!==undefined||c.y!==undefined))return false;
   if(c.sends_application===true){
    const refusal=operation.name==='browser_action'&&['failed','reobserve'].includes(step.disposition)
     && ['Before this send, review actual saved answers, documents and vacancy with candidate sources using record_application_review. No send was attempted or queued.',
      'Inspect the selected resume and call prepare_application with its account resume ID, complete answers and cover letter before the final send.'].some(prefix=>String(step.result).startsWith(prefix));
    if(!refusal)return false;
   }else if(c.action==='click'&&c.sends_application!==false)return false;
   if(c.action==='navigate'&&c.value!==trace.job?.url)return false;
  }
 }
 return true;
}
function evidence(owner:string,name:string){
 const file=resolve(owner,'traces',name),stat=lstatSync(file);
 if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32*1024*1024||realpathSync(file)!==file)throw Error('Unsafe retry evidence');
 const bytes=readFileSync(file);return {value:JSON.parse(bytes.toString('utf8')),hash:createHash('sha256').update(bytes).digest('hex')};
}
export async function approvedRunRepairs(userId:string){
 if(!/^\d+$/.test(userId))throw Error('Invalid account');
 const rows=await query<{id:string;payload:PreparedApplication}>(`SELECT r.id::text,r.payload FROM application_reviews r
  WHERE r.user_id=$1 AND r.status='failed' AND r.credit_consumed AND r.updated_at>now()-interval '7 days'
  AND (r.security_retry_after IS NULL OR r.security_retry_after<=now())
  AND NOT EXISTS(SELECT 1 FROM application_review_operator_holds h WHERE h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL)
  ORDER BY r.updated_at DESC LIMIT 20`,[userId]);
 const eligible:Array<{id:string;revision:string;retry:true;title:string;company:string;sourceRunId:string;finishedAt:string}>=[];
 if(!rows.length)return eligible;
 let db:DatabaseSync|undefined;
 try{
  const owner=resolve(userDir(userId));if(realpathSync(owner)!==owner)throw Error('Unsafe owner');
  const file=resolve(owner,'application-recovery.sqlite');if(lstatSync(file).isSymbolicLink()||realpathSync(file)!==file)throw Error('Unsafe checkpoint');
  db=new DatabaseSync(file,{readOnly:true});
  const applied=await query<{job_id:string;title:string;company:string;url:string}>(`SELECT job_id,title,company,url FROM applications WHERE user_id=$1 AND submitted_by_myasis AND confirmation_status IS NULL`,[userId]);
  const known=new Set(applied.flatMap(x=>applicationKeys({id:x.job_id,title:x.title,company:x.company,url:x.url,location:''})));
  for(const row of rows){try{
   const job=row.payload.job;
   const normal=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
   if(!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)||applicationKeys(job).some(k=>known.has(k))
    ||applied.some(x=>x.job_id===job.id||normal(x.title)===normal(job.title)&&normal(x.company)===normal(job.company)))continue;
   const pointer=evidence(owner,job.id+'.json'),t=pointer.value;
   if(!/^[a-f0-9-]{36}$/.test(t.attemptId)||t.jobId!==job.id)continue;
   const immutable=evidence(owner,'attempt-'+t.attemptId+'.json');if(pointer.hash!==immutable.hash)continue;
   const record=db.prepare('SELECT state FROM recovery_records WHERE id=?').get(t.attemptId) as {state:string}|undefined;
   if(!record||!approvedRepairProof(t,JSON.parse(record.state),row.payload.revision))continue;
   const run=await query<{id:string;finished_at:Date}>(`SELECT id::text,finished_at FROM run_starts WHERE user_id=$1 AND id=$2 AND finished_at>now()-interval '7 days'`,[userId,t.runStartId]);
   if(!run.length||evidence(owner,job.id+'.json').hash!==pointer.hash)continue;
   eligible.push({id:row.id,revision:row.payload.revision,retry:true,title:job.title,company:job.company,sourceRunId:run[0].id,finishedAt:new Date(run[0].finished_at).toISOString()});
  }catch{/* A missing, changed or ambiguous attempt is never automatically replayed. */}}
 }catch{/* No trusted owner-scoped checkpoint: normal discovery remains available. */}finally{db?.close();}
 // Repair the most recent failed approved batch, without replaying older runs.
 const latest=eligible.map(x=>x.finishedAt).sort().at(-1);
 return eligible.filter(x=>x.finishedAt===latest);
}
