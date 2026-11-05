import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from 'patchright';
import type { JobListing, CandidateProfile, ApplyOutcome } from './types.js';
import { checkPreparationAccess } from './preparation-access.js';
import { finishedCoverLetterForJob } from './llm.js';
import { agentOnlyResumePath } from './agent/agent-only-evidence.js';
import { resolveResume, loadResumes } from './resume.js';
import { applicationRevision } from './application-review-content.js';
import type { PreparedApplication } from './application-review-types.js';
import { config } from './config.js';
import { runDeadline } from './run-deadline.js';
import { withJobCost } from './cost-ledger.js';
import { withApplicationAttempt, recordDiagnostic } from './agent/attempt-diagnostics.js';
import { persistTrace, type TraceStep } from './agent/loop/trace.js';
import { isExternalApplicationUrl } from './job-board-url.js';
import { outsideScope } from './run-scope.js';
import { applicationAllowance } from './application-allowance.js';

/** Matching remains in the coordinator. This stage never invokes the applying agent. */
export function prepareMatchedJob(page:Page,job:JobListing,profile:CandidateProfile,deps:{access?:typeof checkPreparationAccess;letter?:typeof finishedCoverLetterForJob}={}):Promise<ApplyOutcome>{
  return withJobCost(job.id,async()=>{
    const result=await withApplicationAttempt(job,async()=>{
      const trace:TraceStep[]=[];
      const finish=(outcome:Extract<ApplyOutcome,{status:'prepared'|'skipped'|'error'}>)=>{
        persistTrace(job,outcome.status==='error'?{status:'error',reason:outcome.error}:outcome.status==='prepared'?{status:'prepared',draft:outcome.draft}:{status:'skipped',reason:outcome.reason},trace,job.url,{attempted:false});
        return {outcome:outcome as ApplyOutcome};
      };
      if(runDeadline.reached)return {outcome:{status:'skipped',jobId:job.id,reason:'Run time limit reached before preparation.'} as ApplyOutcome};
      const access=await (deps.access??checkPreparationAccess)(page,job,profile,{onStep:(action,result)=>{
        trace.push({step:trace.length+1,url:job.url,tool:action,args:{},label:action,result,completedAt:new Date().toISOString()});
        recordDiagnostic({severity:'info',category:'preparation_access',stage:'preparation',tool:action,message:result});
      }});
      if(!access.ok)return finish({status:'skipped',jobId:job.id,reason:access.reason});
      const external=isExternalApplicationUrl(access.checkedUrl);
      if(external&&!config.allowExternalApply||outsideScope(external?'external':'hosted')||!await applicationAllowance(external))
        return finish({status:'skipped',jobId:job.id,reason:'This application destination is outside the current scope or allowance.'});
      job.applicationMode=external?'external':'hosted';
      const resume=resolveResume(config.resume.select||undefined)??(!config.resume.select&&loadResumes().length===1?loadResumes()[0]:null);
      const path=resume&&agentOnlyResumePath(resume.id);
      if(!resume||!path)return finish({status:'error',jobId:job.id,error:'Select an available account resume before preparing jobs.'});
      const coverLetter=await (deps.letter??finishedCoverLetterForJob)(job,profile);
      if(!coverLetter.trim())throw Error('Cover-letter preparation returned no letter.');
      const draft:PreparedApplication={id:randomUUID(),revision:'',job,preparedAt:new Date().toISOString(),formUrl:job.applicationUrl??job.url,answers:[],coverLetter,
        resume:resume.fileName,resumeId:resume.id,resumeHash:createHash('sha256').update(readFileSync(path)).digest('hex'),
        preparation:{version:1,stage:'job-and-letter',access:access.access,checkedAt:new Date().toISOString(),checkedUrl:access.checkedUrl}};
      draft.revision=applicationRevision(draft);
      recordDiagnostic({severity:'info',category:'preparation_complete',stage:'preparation',message:'Matching job, cover letter and application access prepared. Application form not filled; nothing submitted.'});
      trace.push({step:trace.length+1,url:job.url,tool:'prepare_job_and_letter',args:{resume_id:resume.id},label:'Prepared matching job and cover letter; form not filled',result:'Saved for candidate review with no application answers or uploads.',completedAt:new Date().toISOString()});
      return finish({status:'prepared',jobId:job.id,draft});
    });return result.outcome;
  });
}
