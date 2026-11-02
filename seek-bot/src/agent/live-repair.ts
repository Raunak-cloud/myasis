import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'patchright';
import { config } from '../config.js';
import { applicationModelEnvironment } from '../application-model.js';
import { RepairPilotDetector } from '../repair-pilot.js';
import { loadRepairRelease, repairId, repairPilotEnabled, REPAIR_RELEASE_ROOT } from '../repair-release.js';
import { traceProvesNoSend } from '../repair-safety.js';
import { currentAttempt, recordDiagnostic } from './attempt-diagnostics.js';
import type { ProgressBudget } from './progress-budget.js';
import type { AgentRunOptions, AgentRunResult } from './loop.js';
import type {ApplicationHelpers} from './application-helpers.js';

export interface RepairContinuation {
  /** Owner-scoped shared record; never a serialized browser action to replay. */
  recoveryId: string;
  attemptId: string; runId: string; page: Page; meter: ProgressBudget;
  helpers?: ApplicationHelpers;
}
export function liveRepairEnabled(): boolean {
  const env=applicationModelEnvironment();
  return env.OWTOMATE_LIVE_REPAIR==='1' && env.OWTOMATE_OWNER_ID==='1'
    && env.OWTOMATE_OWNER_EMAIL==='raunak.vision@gmail.com' && /^[a-f0-9]{40}$/.test(env.OWTOMATE_DEPLOY_SHA??'')
    && repairPilotEnabled();
}
/** Read only this worker's structured diagnostics; no employer text goes to the coder. */
export function liveRepairIncident(): boolean {
  const identity=currentAttempt();
  if(!identity?.runStartId || !liveRepairEnabled()) return false;
  try {
    const path=resolve(config.dataDir,'traces',`run-${identity.runStartId}.diagnostics.jsonl`),stat=lstatSync(path);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>10_000_000)return false;
    const detector=new RepairPilotDetector('1','raunak.vision@gmail.com',true);
    for(const line of readFileSync(path,'utf8').split('\n')) {
      let event;try{event=JSON.parse(line);}catch{continue;}
      if(event.attemptId===identity.attemptId && detector.observe(identity.runStartId,event))return true;
    }
  }catch{ /* No trustworthy incident: retain normal agent recovery. */ }
  return false;
}

type Ticket={status:string;caseId:string;runId:string;attemptId:string;jobId?:string;mode?:string;baseSha?:string;distHash?:string;expiresAt:number};
export function readLiveRepairTicket(runId:string,attemptId:string,root=REPAIR_RELEASE_ROOT,requireRoot=true):Ticket|null {
  if(!/^\d+$/.test(runId)||!repairId(attemptId))return null;
  const file=resolve(root,'tickets',`${runId}-${attemptId}.json`);
  if(!existsSync(file))return null;
  for(const path of [root,resolve(root,'tickets'),file]) {
    const stat=lstatSync(path);
    if(stat.isSymbolicLink() || requireRoot && (stat.uid!==0 || (stat.mode&0o022)))throw Error('Repair ticket is mutable.');
  }
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.size>4096)throw Error('Invalid repair ticket.');
  const ticket=JSON.parse(readFileSync(file,'utf8'));
  if(ticket.runId!==runId||ticket.attemptId!==attemptId||!repairId(ticket.caseId)||!Number.isFinite(ticket.expiresAt)
    || ticket.expiresAt<=Date.now()||ticket.expiresAt>Date.now()+2*3600_000)throw Error('Repair ticket is expired or mismatched.');
  return ticket;
}
export function liveRepairContinuationAllowed(state:RepairContinuation):boolean {
  if(!liveRepairEnabled())return false;
  try {return ['in_run_ready','in_run_running'].includes(readLiveRepairTicket(state.runId,state.attemptId)?.status??'');}
  catch{return false;}
}

interface RecoveryDependencies {
  enabled:()=>boolean; now:()=>number; sleep:(ms:number)=>Promise<void>;
  ticket:(runId:string,attemptId:string)=>Ticket|null;
  safe:(checkpoint:RepairContinuation)=>boolean;
  load:(ticket:Ticket)=>Promise<(options:AgentRunOptions)=>Promise<AgentRunResult>>;
  event:(category:string,caseId?:string)=>void;
}
export async function recoverDuringRun(options:AgentRunOptions,original:AgentRunResult,overrides?:Partial<RecoveryDependencies>):Promise<AgentRunResult> {
  const checkpoint=original.repair;
  if(!checkpoint)return original;
  const {repair:_,...unchanged}=original;
  const unavailable=():AgentRunResult=>({...unchanged,outcome:{status:'skipped',reason:'The application could not finish because its tool failure could not be safely repaired during this run.'}});
  const env=applicationModelEnvironment();
  const deps:RecoveryDependencies={
    enabled:liveRepairEnabled,now:Date.now,sleep:ms=>new Promise(done=>setTimeout(done,ms)),
    ticket:readLiveRepairTicket,
    safe:state=>{
      const path=resolve(config.dataDir,'traces',`attempt-${state.attemptId}.json`),stat=lstatSync(path);
      return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=40_000_000
        && traceProvesNoSend(JSON.parse(readFileSync(path,'utf8')),state.runId,state.attemptId);
    },
    load:async ticket=>{
      if(!ticket.baseSha || !ticket.distHash || ticket.jobId!==options.job.id || ticket.mode!==(env.APPLICATION_REVIEW_MODE||'auto'))throw Error('Repair does not match this job or application mode.');
      const bot=loadRepairRelease(ticket.caseId,{ownerId:env.OWTOMATE_OWNER_ID!,email:env.OWTOMATE_OWNER_EMAIL!,activeAdmin:true,
        expectedBaseSha:ticket.baseSha,currentBaseSha:env.OWTOMATE_DEPLOY_SHA!,expectedDistHash:ticket.distHash,
        lockFile:resolve(import.meta.dirname,'../../package-lock.json')});
      const module=await import(pathToFileURL(resolve(bot,'dist/agent/agent-only.js')).href);
      if(typeof module.runAgentOnlyApplication!=='function')throw Error('Repair entry is missing.');
      return module.runAgentOnlyApplication;
    },
    event:(category,caseId)=>recordDiagnostic({category,severity:category==='repair_resume_error'?'error':'info',stage:'application',repairCaseId:caseId,
      relatedAttemptId:checkpoint.attemptId,message:category==='repair_waiting'?'Application is waiting at a safe checkpoint for a tested tool repair.':category==='repair_resumed'?'Validated tool repair resumed the existing application in the same run.':'In-run repair checkpoint ended.'}),
    ...overrides,
  };
  if(options.continuation||original.submitPressed||original.outcome.status!=='skipped')return unchanged;
  if(!deps.enabled()||checkpoint.page.isClosed()||!deps.safe(checkpoint))return unavailable();
  deps.event('repair_waiting');
  const deadline=deps.now()+6*60_000;
  try {
    while(deps.now()<deadline&&deps.enabled()&&!checkpoint.page.isClosed()) {
      const ticket=deps.ticket(checkpoint.runId,checkpoint.attemptId);
      if(ticket) {
        if(ticket.status!=='in_run_ready') {deps.event('repair_cancelled',ticket.caseId);return unavailable();}
        if(!deps.safe(checkpoint)||!deps.enabled())return unavailable();
        const run=await deps.load(ticket);
        if(!deps.enabled()||checkpoint.page.isClosed())return unavailable();
        deps.event('repair_resumed',ticket.caseId);
        // The prior agent has returned and removed listeners. Only this
        // continuation may now write to its existing page; no run is started.
        const result=await run({...options,page:checkpoint.page,continuation:checkpoint});
        deps.event('repair_completed',ticket.caseId);
        return {...result,repair:undefined,steps:original.steps+result.steps};
      }
      await deps.sleep(1000);
    }
    deps.event('repair_expired');
  }catch(error) {
    deps.event('repair_resume_error');
    // A resumed agent may have sent. Never return the old "unsent" result
    // after invoking it; let normal infrastructure/uncertain-send handling run.
    throw error;
  }
  return unavailable();
}
