import { getPool } from '../db/index.js';
import type { PoolClient } from 'pg';
import { readEnv, deploying } from '../runner.js';
import { loadProfile } from '../profile.js';
import { gmailAccess } from '../gmail-access.js';
import { accountRequest } from '../account-lifecycle.js';
import { HrStore, type HrJob, type HrPhase } from './store.js';
import { discoverHiringContact, canReuseHiringContact, assessHiringContact, type HiringContact, type DiscoveryResult } from './discovery.js';
import { hrContactSearch } from './search.js';
import { composeHrEmail } from './agent.js';
import { sendHrEmail, reconcileHrEmail, hrDeliveredBody, type HrMail } from './transport.js';
import { withHrBrowser } from './browser.js';
import { markHrActive } from './activity.js';

interface Slots { claimStart(userId:string):boolean; releaseStart(userId:string):void; activeCount?():number }
let wakeWorker:(()=>void)|null=null;
/** Run completion wakes this process's worker only after releasing its slot. */
export function wakeHrOutreach():void {wakeWorker?.();}
export interface HrWorkerDependencies {
  store: HrStore;
  discover: typeof discoverHiringContact;
  compose: typeof composeHrEmail;
  send: typeof sendHrEmail;
  reconcile: typeof reconcileHrEmail;
  access: typeof gmailAccess;
  profile: typeof loadProfile;
  apiKey: () => string;
  verifyContact?: typeof canReuseHiringContact;
  log?: (event:{jobId:string;stage:HrPhase;code:string})=>void;
}
const defaultDependencies: HrWorkerDependencies = {
  store:new HrStore(), discover:discoverHiringContact,compose:composeHrEmail,send:sendHrEmail,reconcile:reconcileHrEmail,
  access:gmailAccess,profile:loadProfile,apiKey:()=>({...readEnv(),...process.env}).OPENROUTER_API_KEY||'',
  verifyContact:canReuseHiringContact,
};
/** One durable job owns one send attempt. Recovery never retries an uncertain send. */
export async function processHrJob(job: HrJob, deps: HrWorkerDependencies = defaultDependencies): Promise<void> {
  const {store}=deps;
  let sending=false, measuredCost=0, costSaved=false, stage:HrPhase=job.status==='unconfirmed'?'checking':'researching';
  const signal=AbortSignal.timeout(180_000);
  try {
    if(!await store.allowed(job))return;
    await store.setPhase?.(job,job.status==='unconfirmed'?'checking':'researching');
    const access=await deps.access(job.user_id);
    if(!access.connected) {await store.finish(job,job.status==='unconfirmed'?'unconfirmed':'error','Connect your profile Gmail address to send or check HR emails.',undefined,0,{retryable:false});return;}
    if(job.status==='unconfirmed') {
      if(!job.to_email||!job.subject||!job.body){await store.finish(job,'unconfirmed','Email delivery needs checking. It will not be sent again automatically.');return;}
      const receipt=await deps.reconcile(job.user_id,{id:job.id,to:job.to_email,subject:job.subject,body:job.body,createdAt:new Date(job.created_at).toISOString()},
        {withBrowser:action=>withHrBrowser(job.user_id,action)});
      await store.finish(job,receipt?'sent':'unconfirmed',receipt?null:'Email delivery could not be confirmed. It will not be sent again automatically.',receipt??undefined);
      return;
    }
    const cache=await store.cache(job.company_key);
    const associated=cache?.contact?!assessHiringContact(cache.contact,job.company,job.title).reviewRequired&&await (deps.verifyContact?.(job.company,job.url,cache.contact,{signal})??Promise.resolve(true)):true;
    let contact:HiringContact|null=cache?.fresh&&associated?cache.contact:null;
    if(!cache?.fresh||!associated) {
      const found=await deps.discover({company:job.company,jobUrl:job.url,roleTitle:job.title,previous:associated?cache?.contact??undefined:undefined,signal},{search:deps===defaultDependencies?hrContactSearch():undefined,maxPages:12});
      await store.recordLookup?.(job,found);
      if(found.retryable&&!found.contact){await store.finish(job,'error',found.reason,undefined,0,{retryable:true});return;}
      contact=found.contact;
      await store.saveContact(job.company_key,job.company,contact,found.reason,found);
      if(!contact){await store.finish(job,'skipped',found.reason,undefined,0,{retryable:false});return;}
    } else {
      const reused:DiscoveryResult={contact,reason:cache!.reason??'Reused a recently checked public contact.',pagesRead:0,retryable:false,
        outcome:cache!.outcome??(contact?'found':'no_contact'),diagnostics:cache!.diagnostics??{stage:'revalidation',searches:0,pagesAttempted:0,pagesRead:0,pagesBlocked:0,pagesFailed:0,candidatesRejected:0,unresolvedPriorityPages:0,events:[]}};
      await store.recordLookup?.(job,reused);
    }
    if(!contact) {await store.finish(job,'skipped',cache?.reason||'No publicly listed hiring or recruitment email was found.',undefined,0,{retryable:false});return;}
    const profile=await deps.profile(job.user_id);
    stage='writing';
    await store.setPhase?.(job,'writing');
    const draft=await deps.compose({candidate:{name:profile.fullName,evidence:JSON.stringify({headline:profile.headline,experience:profile.experienceSummary,skills:profile.skills,
      qualification:profile.highestQualification,submittedCoverLetter:job.cover_letter})},job:{title:job.title,company:job.company,url:job.url},contact},
    {apiKey:deps.apiKey(),signal});
    measuredCost=draft.costUsd;
    const mail:HrMail={id:job.id,to:contact.email,subject:draft.subject,body:draft.body,createdAt:new Date(job.created_at).toISOString()};
    mail.body=hrDeliveredBody(mail);
    await store.draft(job,contact,mail.subject,mail.body,measuredCost);costSaved=true;
    if(!await store.allowed(job)||!await store.sending(job))return;
    sending=true;stage='sending';
    const receipt=await deps.send(job.user_id,mail,{withBrowser:action=>withHrBrowser(job.user_id,action)});
    await store.finish(job,'sent',null,receipt);
  }catch(error) {
    // Never expose provider payloads or diagnostic stacks in the customer history.
    const failure=error as {code?:string;costUsd?:number;definitiveRejection?:boolean};
    const code=['reconnect','unapproved','uncertain','unavailable'].includes(failure.code??'')?failure.code!:(signal.aborted?'deadline_exceeded':'unexpected_error');
    // IDs and controlled codes are sufficient to correlate failures without
    // copying Gmail payloads, candidate evidence or provider secrets into logs.
    const diagnostic={jobId:job.id,stage,code};
    (deps.log??(event=>console.warn('[hr-outreach]',JSON.stringify(event))))(diagnostic);
    await store.recordFailure?.(job,stage,code);
    if(!costSaved)measuredCost=Number.isFinite(failure.costUsd)?Math.max(0,failure.costUsd!):measuredCost;
    const ambiguous=job.status==='unconfirmed'||sending&&!failure.definitiveRejection&&!['reconnect','unapproved'].includes(failure.code||'');
    await store.finish(job,ambiguous?'unconfirmed':'error',ambiguous
      ?'Email delivery could not be confirmed. It will not be sent again automatically.'
      :code==='reconnect'?'Reconnect your profile Gmail address to continue HR outreach.'
      :code==='unapproved'?'HR outreach is not available for this account.'
      :stage==='researching'?'The hiring contact search could not finish.'
      :stage==='writing'?'The HR email could not be written.'
      :'Gmail did not accept this HR email.',undefined,costSaved?0:measuredCost,{retryable:!['reconnect','unapproved'].includes(code)});
  }
}

/** Runs beside application workers, independently of dashboard restarts. */
export function startHrOutreachWorker(slots: Slots) {
  let stopped=false,active:Promise<void>|null=null,wakeRequested=false;
  const tick=async()=>{
    if(stopped||active||deploying())return;
    active=(async()=>{
      let clearActivity=()=>{};
      let client:PoolClient|undefined;let locked=false;
      try {
        if(deploying())return;
        client=await getPool().connect();
        locked=(await client.query('SELECT pg_try_advisory_lock(726302,1) AS locked')).rows[0].locked;
        if(!locked)return;
        clearActivity=markHrActive();
        if(deploying())return;
        const store=defaultDependencies.store;
        await store.recover();await store.enqueue();
        if(stopped||deploying())return;
        const job=await store.claim();
        if(job) {
          if(!slots.claimStart(job.user_id)){await store.defer(job);return;}
          try {await accountRequest(job.user_id,()=>processHrJob(job));}
          finally{slots.releaseStart(job.user_id);}
        }
        // Monthly maintenance follows ready outreach and does not perform
        // network lookups while an applying run is active.
        if(!stopped&&!deploying()&&(slots.activeCount?.()??0)===0){
          const cached=await store.staleContact();
          if(cached){const found=await discoverHiringContact({company:cached.company,previous:cached.contact,signal:AbortSignal.timeout(90_000)},{search:hrContactSearch(),maxPages:8});
            if(found.retryable&&!found.contact)await store.deferValidation(cached.company_key);
            else await store.saveContact(cached.company_key,cached.company,found.contact,found.reason,found);}
        }
      }finally{try{if(locked)await client?.query('SELECT pg_advisory_unlock(726302,1)');}finally{client?.release();clearActivity();}}
    })().catch(()=>console.warn('[hr-outreach] background task deferred')).finally(()=>{active=null;if(wakeRequested&&!stopped){wakeRequested=false;setImmediate(()=>void tick());}});
    await active;
  };
  const timer=setInterval(()=>void tick(),30_000);timer.unref();void tick();
  const wake=()=>{if(active)wakeRequested=true;else void tick();};wakeWorker=wake;
  return {async stop(){stopped=true;clearInterval(timer);if(wakeWorker===wake)wakeWorker=null;await active;}};
}
