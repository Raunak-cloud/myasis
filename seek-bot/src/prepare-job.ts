import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { JobListing, CandidateProfile, ApplyOutcome } from './types.js';
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
import type {Page} from 'patchright';
import {applicationModelEnvironment} from './application-model.js';
import {inspectGuestPreparation,type GuestAccessProof} from './guest-preparation.js';

/** Paid listing preparation stays lightweight. Free preparation verifies access before spending a credit or drafting a letter. */
export function prepareMatchedJob(job:JobListing,profile:CandidateProfile,deps:{letter?:typeof finishedCoverLetterForJob;page?:Page;access?:typeof inspectGuestPreparation}={}):Promise<ApplyOutcome>{
  return withJobCost(job.id,async()=>{
    const result=await withApplicationAttempt(job,async()=>{
      const trace:TraceStep[]=[];
      const finish=(outcome:Extract<ApplyOutcome,{status:'prepared'|'skipped'|'error'}>)=>{
        persistTrace(job,outcome.status==='error'?{status:'error',reason:outcome.error}:outcome.status==='prepared'?{status:'prepared',draft:outcome.draft}:{status:'skipped',reason:outcome.reason},trace,job.url,{attempted:false});
        return {outcome:outcome as ApplyOutcome};
      };
      if(runDeadline.reached)return {outcome:{status:'skipped',jobId:job.id,reason:'Run time limit reached before preparation.'} as ApplyOutcome};
      if(!job.description?.trim())return finish({status:'error',jobId:job.id,error:'Read the job listing description before preparing its cover letter.'});
      const resume=resolveResume(config.resume.select||undefined)??(!config.resume.select&&loadResumes().length===1?loadResumes()[0]:null);
      const path=resume&&agentOnlyResumePath(resume.id);
      if(!resume||!path)return finish({status:'error',jobId:job.id,error:'Select an available account resume before preparing jobs.'});
      let guestProof:GuestAccessProof|undefined;
      if(applicationModelEnvironment().FREE_EMPLOYER_GUEST_ONLY==='true'){
        if(!deps.page)return finish({status:'error',jobId:job.id,error:'The application browser is unavailable; guest access was not confirmed.'});
        const access=await (deps.access??inspectGuestPreparation)(deps.page,job,{onStep:step=>{
          trace.push({step:trace.length+1,url:step.url,tool:step.tool,args:step.args,label:step.tool,result:step.result,screenshot:step.screenshot,completedAt:new Date().toISOString()});
          recordDiagnostic({severity:'info',category:'preparation_access',stage:'preparation',tool:step.tool,message:step.result});
        }});
        if(!access.ok)return finish(access.status==='skipped'?{status:'skipped',jobId:job.id,reason:access.reason}:{status:'error',jobId:job.id,error:access.reason});
        if(job.platform==='jora'&&access.proof.access==='hosted-confirmed')return finish({status:'skipped',jobId:job.id,reason:'Free Jora discovery supports direct employer applications only. Use the connected job board for a native board application.'});
        guestProof=access.proof;
      }
      const coverLetter=await (deps.letter??finishedCoverLetterForJob)(job,profile);
      if(!coverLetter.trim())throw Error('Cover-letter preparation returned no letter.');
      const draft:PreparedApplication={id:randomUUID(),revision:'',job,preparedAt:new Date().toISOString(),formUrl:job.applicationUrl??job.url,answers:[],coverLetter,
        resume:resume.fileName,resumeId:resume.id,resumeHash:createHash('sha256').update(readFileSync(path)).digest('hex'),
        preparation:guestProof??{version:2,stage:'job-and-letter',access:'not-checked',listingUrl:job.url}};
      draft.revision=applicationRevision(draft);
      recordDiagnostic({severity:'info',category:'preparation_complete',stage:'preparation',message:guestProof?'Application access confirmed without an employer account, then cover letter prepared. No candidate data entered and nothing submitted.':'Matching listing and cover letter prepared. Application access and login are deferred until Apply; no form opened or filled, nothing submitted.'});
      trace.push({step:trace.length+1,url:job.url,tool:'prepare_job_and_letter',args:{resume_id:resume.id},label:'Prepared matching job and cover letter; form not filled',result:'Saved for candidate review with no application answers or uploads.',completedAt:new Date().toISOString()});
      return finish({status:'prepared',jobId:job.id,draft});
    });return result.outcome;
  });
}
