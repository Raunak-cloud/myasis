import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from './db/index.js';
import { runner, deploying } from './runner.js';
import { startRun } from './start-run.js';
import { isAdmin } from './admin-access.js';
import { userDir } from './userdata.js';
import { repairId, repairPilotEnabled } from './repair-release.js';
import { repairRetryAllowed } from './repair-retry-policy.js';
import { traceProvesNoSend } from './repair-validation.js';

let ticking = false;
interface RetryDependencies {
  query: typeof query;
  runner: Pick<typeof runner,'inUse'|'runIdFor'>;
  startRun: typeof startRun;
  enabled: () => boolean;
  deploying: typeof deploying;
  isAdmin: typeof isAdmin;
  readTrace: (attemptId:string) => any;
}
const defaults:RetryDependencies={query,runner,startRun,enabled:repairPilotEnabled,deploying,isAdmin,
  readTrace:attemptId=>JSON.parse(readFileSync(resolve(userDir('1'),'traces',`attempt-${attemptId}.json`),'utf8'))};
/** Runs inside the dashboard's existing runner so normal claims, concurrency,
 * entitlements, candidate approval and account audit apply to every retry. */
export async function repairRetryTick(deps:RetryDependencies=defaults): Promise<void> {
  const {query,runner,startRun,enabled,deploying,isAdmin,readTrace}=deps;
  if (ticking || !enabled() || deploying() || runner.inUse('1')) return;
  if(deps===defaults) {try {if(JSON.parse(readFileSync('/etc/owtomate-repair-pilot.json','utf8')).recoveryMode==='in-run')return;}catch{return;}}
  ticking = true;
  try {
    const [row] = await query<any>(`SELECT c.id::text,c.run_id::text,c.attempt_id::text,c.created_at,u.email,
      r.finished_at,r.stopped,r.trigger,s.enabled AS schedule_enabled,s.application_mode AS schedule_mode
      FROM repair_pilot_cases c JOIN users u ON u.id=c.user_id JOIN run_starts r ON r.id=c.run_id AND r.user_id=c.user_id
      LEFT JOIN application_schedules s ON s.user_id=c.user_id
      WHERE c.user_id=1 AND c.status='retry_pending' AND u.blocked_at IS NULL ORDER BY c.created_at LIMIT 1`);
    if (!row) return;
    const block = async (detail:string) => { await query("UPDATE repair_pilot_cases SET status='blocked',detail=$2,updated_at=now() WHERE id=$1 AND status='retry_pending'",[row.id,detail]); };
    if (!repairId(row.id) || !repairId(row.attempt_id) || !isAdmin(row.email) || !row.finished_at || row.stopped
      || Date.now()-new Date(row.created_at).getTime()>2*60*60*1000) { await block('Repair retry is stale, stopped or unavailable.'); return; }
    let trace: any;
    try { trace = readTrace(row.attempt_id); }
    catch { await block('Retry trace is unavailable.'); return; }
    if (!traceProvesNoSend(trace,row.run_id,row.attempt_id) || typeof trace.jobId !== 'string' || trace.job?.id !== trace.jobId) { await block('No retry: prior send state or original job is uncertain.'); return; }
    if(row.trigger==='auto' && row.schedule_mode!==(trace.mode==='prepare'?'semi-auto':'auto')) { await block('Schedule application mode changed; repair authorization is stale.'); return; }
    const existing = await query('SELECT 1 FROM applications WHERE user_id=1 AND job_id=$1 LIMIT 1',[trace.jobId]);
    const attention = await query("SELECT 1 FROM run_events WHERE user_id=1 AND job_id=$1 AND status='needs-human' AND ts >= $2 LIMIT 1",[trace.jobId,row.created_at]);
    const active = await query('SELECT 1 FROM run_starts WHERE user_id=1 AND finished_at IS NULL LIMIT 1');
    if (existing.length || attention.length) { await block('No retry: an application or unanswered candidate question exists.'); return; }
    if (active.length) return;
    let approvals: unknown = undefined;
    if (trace.mode === 'approved') {
      const [review] = await query<any>("SELECT id::text,status,payload->>'revision' revision FROM application_reviews WHERE user_id=1 AND payload->'job'->>'id'=$1",[trace.jobId]);
      if (review?.status !== 'failed' || !trace.sendAudit.approvedRevision || review.revision !== trace.sendAudit.approvedRevision) { await block('The exact candidate-approved revision is no longer available.'); return; }
      approvals = [{id:review.id,revision:review.revision,retry:true}];
    }
    if (!repairRetryAllowed({ownerId:'1',ownerEmail:row.email,activeAdmin:true,originalRunFinished:true,currentRunActive:false,
      schedulePaused:row.trigger==='auto' && row.schedule_enabled!==true,repairValidated:true,outcome:'failed',sendState:'proven-not-attempted',
      mode:trace.mode==='auto'?'auto':trace.mode==='prepare'?'prepare':'semi-auto',candidateApprovedRevision:Boolean(approvals),sameJobAndRevision:true})) {
      await block('Retry requires an active schedule and the existing application authorization.'); return;
    }
    const claimed = await query("UPDATE repair_pilot_cases SET status='retry_claimed',updated_at=now() WHERE id=$1 AND status='retry_pending' RETURNING id",[row.id]);
    if (!claimed.length) return;
    try {
      const result = await startRun({userId:'1',email:row.email,mode:'live',applicationMode:trace.mode==='prepare'?'semi-auto':'auto',trigger:'admin',startedBy:'1',
        repairCaseId:row.id,approvals,repairJob:approvals?undefined:trace.job,oneTime:approvals?undefined:{maxApplications:1,maxEvaluations:1}});
      await query("UPDATE repair_pilot_cases SET status=$2,retry_run_id=$3,detail=$4,updated_at=now() WHERE id=$1",
        [row.id,result.ok?'retry_started':'blocked',result.ok?runner.runIdFor('1'):null,result.ok?'Validated repair retry started.':result.error]);
    } catch { await query("UPDATE repair_pilot_cases SET status='blocked',detail='Repair retry could not start; no further retry queued.',updated_at=now() WHERE id=$1",[row.id]); }
  } finally { ticking = false; }
}
