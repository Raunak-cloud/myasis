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
import {applicationAllowance} from './application-allowance.js';
import {gmailAccount,gmailAvailable} from './gmail-mailbox.js';
import {isExternalApplicationUrl,jobBoardForUrl} from './job-board-url.js';
import {outsideScope,scopeSkipReason} from './run-scope.js';

/** Verify uncertain and employer destinations before spending a preparation credit. */
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
      let email:PreparedApplication['email'];
      const env=applicationModelEnvironment();
      const freeGuestOnly=env.FREE_EMPLOYER_GUEST_ONLY==='true';
      const paidPlanPolicy=!freeGuestOnly&&['true','false'].includes(env.EMPLOYER_GUEST_ONLY??'');
      const listingBoard=jobBoardForUrl(job.url);
      const nativeBoard=listingBoard===(job.platform??'seek')?listingBoard:null;
      const source=job.applicationUrl??job.url;
      const knownNative=job.applicationMode==='hosted'&&nativeBoard
        &&jobBoardForUrl(source)===nativeBoard&&!isExternalApplicationUrl(source);
      const matchingGmail=gmailAvailable()&&Boolean(profile.email?.trim())
        &&gmailAccount().trim().toLowerCase()===profile.email.trim().toLowerCase();
      const canRegister=paidPlanPolicy&&env.EMPLOYER_GUEST_ONLY==='false'&&matchingGmail;
      const skip=(reason:string)=>finish({status:'skipped',jobId:job.id,reason});
      if(freeGuestOnly||paidPlanPolicy&&!knownNative){
        if(!deps.page)return finish({status:'error',jobId:job.id,error:'The application browser is unavailable; access was not confirmed.'});
        const access=await (deps.access??inspectGuestPreparation)(deps.page,job,{allowRegistration:canRegister,
          nativeBoard:paidPlanPolicy?nativeBoard:undefined,onStep:step=>{
          trace.push({step:trace.length+1,url:step.url,tool:step.tool,args:step.args,label:step.tool,result:step.result,screenshot:step.screenshot,completedAt:new Date().toISOString()});
          recordDiagnostic({severity:'info',category:'preparation_access',stage:'preparation',tool:step.tool,message:step.result});
        }});
        if(!access.ok)return finish(access.status==='skipped'?{status:'skipped',jobId:job.id,reason:access.reason}:{status:'error',jobId:job.id,error:access.reason});
        const hosted=access.proof.access==='hosted-confirmed';
        if(hosted&&job.platform==='jora')return skip('Jora discovery requires a direct employer application. Use the connected board for its native application.');
        if(access.proof.access==='registration-confirmed'&&!canRegister)return skip('This employer requires account creation. Use Get Owtomated with the profile Gmail connected.');
        if(paidPlanPolicy||freeGuestOnly){
          const destination=hosted?'hosted':'external';
          if(hosted&&(!nativeBoard||jobBoardForUrl(access.proof.checkedUrl)!==nativeBoard))
            return skip('This listing opens a different job board. Apply through that board’s listing instead.');
          if(outsideScope(destination))return skip(scopeSkipReason());
          if(!hosted&&(paidPlanPolicy&&!config.allowExternalApply||!await applicationAllowance(true)))return skip('No employer-site application allowance is available for this destination.');
          if(paidPlanPolicy&&access.proof.method==='email'){
            if(!matchingGmail||!access.emailTo)return skip('This job accepts applications by email. Connect the profile Gmail before preparing it.');
            email={to:access.emailTo,subject:`Application for ${job.title.replace(/[\r\n]+/g,' ').trim().slice(0,130)}`};
          }
          job.applicationMode=destination;
        }
        guestProof=access.proof;
      }
      const coverLetter=await (deps.letter??finishedCoverLetterForJob)(job,profile);
      if(!coverLetter.trim())throw Error('Cover-letter preparation returned no letter.');
      const draft:PreparedApplication={id:randomUUID(),revision:'',job,preparedAt:new Date().toISOString(),formUrl:job.applicationUrl??job.url,answers:[],coverLetter,
        resume:resume.fileName,resumeId:resume.id,resumeHash:createHash('sha256').update(readFileSync(path)).digest('hex'),
        preparation:guestProof??{version:2,stage:'job-and-letter',access:'not-checked',listingUrl:job.url},...(email?{email}:{})};
      draft.revision=applicationRevision(draft);
      recordDiagnostic({severity:'info',category:'preparation_complete',stage:'preparation',message:guestProof?'The application route was checked against plan access before the cover letter was prepared. No candidate data entered and nothing submitted.':'Matching listing and cover letter prepared. Application form filling is deferred until Apply.'});
      trace.push({step:trace.length+1,url:job.url,tool:'prepare_job_and_letter',args:{resume_id:resume.id},label:'Prepared matching job and cover letter; form not filled',result:'Saved for candidate review with no application answers or uploads.',completedAt:new Date().toISOString()});
      return finish({status:'prepared',jobId:job.id,draft});
    });return result.outcome;
  });
}
