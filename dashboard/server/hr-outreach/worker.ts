import { getPool } from '../db/index.js';
import { createHash } from 'node:crypto';
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
import { loadPublicVacancyEvidence } from './public-evidence.js';
import { checkHrBounce } from './bounce.js';
import type { HrDeliveryJob } from './delivery-store.js';
import { researchHiringContact } from './research.js';

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
  publicEvidence?: typeof loadPublicVacancyEvidence;
  checkBounce?: typeof checkHrBounce;
  research?: typeof researchHiringContact;
  log?: (event:{jobId:string;stage:HrPhase;code:string})=>void;
}
const defaultDependencies: HrWorkerDependencies = {
  store:new HrStore(), discover:discoverHiringContact,compose:composeHrEmail,send:sendHrEmail,reconcile:reconcileHrEmail,
  access:gmailAccess,profile:loadProfile,apiKey:()=>({...readEnv(),...process.env}).OPENROUTER_API_KEY||'',
  verifyContact:canReuseHiringContact,publicEvidence:loadPublicVacancyEvidence,checkBounce:checkHrBounce,
  research:researchHiringContact,
};
function parentEmployerWebsite(contact:HiringContact|null|undefined):string|undefined {
  if(contact?.sourceKind!=='public_page')return;
  try{const url=new URL(contact.sourceUrl),host=url.hostname.replace(/^www\./,'').toLowerCase(),root=contact.companyDomain.replace(/^www\./,'').toLowerCase();
    if(url.protocol==='https:'&&!url.username&&!url.password&&(host===root||host.endsWith('.'+root)))return url.href;
  }catch{ /* A prior source is a hint only; public discovery validates it again. */ }
}
/** One durable job owns one send attempt. Recovery never retries an uncertain send. */
export async function processHrJob(job: HrJob, deps: HrWorkerDependencies = defaultDependencies): Promise<void> {
  const {store}=deps;
  let sending=false, measuredCost=0, costSaved=false, stage:HrPhase=job.status==='unconfirmed'?'checking':'researching';
  const signal=AbortSignal.timeout(480_000);
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
    const evidence=await deps.publicEvidence?.(job)??null;
    const excludedEmails=(await store.invalidEmails?.()??[]).map(email=>email.trim().toLowerCase());
    const excluded=new Set(excludedEmails);
    const vacancy={roleTitle:job.title,location:job.location||evidence?.location||undefined,
      jobDescription:evidence?.description,jobDescriptionObservedAt:evidence?.observedAt,excludedEmails};
    const contextKey=createHash('sha256').update(JSON.stringify(['agent-research-v1',job.url,job.title,vacancy.location??'',vacancy.jobDescription??'',vacancy.jobDescriptionObservedAt??'',[...excludedEmails].sort()])).digest('hex');
    const cache=await store.cache(job.company_key);
    // A company-wide negative result cannot suppress new vacancy-specific
    // recruitment evidence, even while yesterday's website lookup is cached.
    const fresh=cache?.fresh&&(cache.contact!==null||cache.contextKey===contextKey);
    const associated=cache?.contact?!excluded.has(cache.contact.email.toLowerCase())&&!assessHiringContact(cache.contact,job.company,job.title).reviewRequired&&await (deps.verifyContact?.(job.company,job.url,cache.contact,{signal,...vacancy})??Promise.resolve(true)):true;
    let contact:HiringContact|null=fresh&&associated?cache!.contact:null;
    if(!fresh||!associated) {
      const previous=associated&&cache?.contact?cache.contact:job.retry_parent_contact??undefined;
      const researchInput={company:job.company,jobUrl:job.url,website:parentEmployerWebsite(job.retry_parent_contact),...vacancy,previous,signal};
      let found=await deps.discover(researchInput,{search:deps===defaultDependencies?hrContactSearch():undefined,maxPages:12});
      if(!found.contact&&deps.research){
        const additional=await deps.research(researchInput,found,{apiKey:deps.apiKey(),search:deps===defaultDependencies?hrContactSearch():undefined});
        measuredCost+=additional.costUsd;
        if(store.researchCost){await store.researchCost(job,measuredCost);measuredCost=0;}
        found=additional;
      }
      await store.recordLookup?.(job,found);
      if(found.retryable&&!found.contact){await store.finish(job,'error',found.reason,undefined,measuredCost,{retryable:true});return;}
      contact=found.contact;
      await store.saveContact(job.company_key,job.company,contact,found.reason,found,contextKey);
      if(!contact){await store.finish(job,'skipped',found.reason,undefined,measuredCost,{retryable:false});return;}
    } else {
      const reused:DiscoveryResult={contact,reason:cache!.reason??'Reused a recently checked public contact.',pagesRead:0,retryable:false,
        outcome:cache!.outcome??(contact?'found':'no_contact'),diagnostics:cache!.diagnostics??{stage:'revalidation',searches:0,pagesAttempted:0,pagesRead:0,pagesBlocked:0,pagesFailed:0,candidatesRejected:0,unresolvedPriorityPages:0,events:[]}};
      await store.recordLookup?.(job,reused);
    }
    if(!contact) {await store.finish(job,'skipped',cache?.reason||'No publicly listed hiring or recruitment email was found.',undefined,0,{retryable:false});return;}
    if(excluded.has(contact.email.toLowerCase())){await store.finish(job,'skipped','This email address was rejected by the employer. No suitable alternate contact was found.',undefined,0,{retryable:false});return;}
    const profile=await deps.profile(job.user_id);
    stage='writing';
    await store.setPhase?.(job,'writing');
    const draft=await deps.compose({candidate:{name:profile.fullName,evidence:JSON.stringify({headline:profile.headline,experience:profile.experienceSummary,skills:profile.skills,
      qualification:profile.highestQualification,submittedCoverLetter:job.cover_letter})},job:{title:job.title,company:job.company,url:job.url},contact},
    {apiKey:deps.apiKey(),signal});
    measuredCost+=draft.costUsd;
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

/** Inspect only an existing sent message. No notice is not delivery proof. */
export async function processHrDeliveryCheck(job:HrDeliveryJob,deps:HrWorkerDependencies=defaultDependencies):Promise<void> {
  if(!deps.checkBounce||!await deps.store.deliveryAllowed(job))return;
  try{
    if(!job.to_email||!job.subject||!job.body)throw Error('Incomplete recorded send.');
    const notice=await deps.checkBounce(job.user_id,{id:job.id,to:job.to_email,subject:job.subject,body:job.body,createdAt:new Date(job.created_at).toISOString()},
      {sentAt:new Date(job.sent_at).toISOString(),threadId:job.thread_id??undefined,signal:AbortSignal.timeout(120_000),withBrowser:action=>withHrBrowser(job.user_id,action)});
    await deps.store.recordDeliveryCheck(job,notice);
  }catch{
    (deps.log??(event=>console.warn('[hr-outreach]',JSON.stringify(event))))({jobId:job.id,stage:'checking',code:'delivery_check_unavailable'});
    await deps.store.recordDeliveryCheck(job,null,true);
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
        const delivery=await store.claimDelivery();
        if(delivery){
          if(slots.claimStart(delivery.user_id)){
            try{await accountRequest(delivery.user_id,()=>processHrDeliveryCheck(delivery));}
            finally{slots.releaseStart(delivery.user_id);}
          }else await store.deferDelivery(delivery);
        }
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
          if(cached){const found=await discoverHiringContact({company:cached.company,previous:cached.contact,excludedEmails:await store.invalidEmails(),signal:AbortSignal.timeout(90_000)},{search:hrContactSearch(),maxPages:8});
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
