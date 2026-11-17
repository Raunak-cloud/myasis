import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processHrJob,type HrWorkerDependencies } from './worker.js';
import type { HrJob } from './store.js';
import type { HiringContact, DiscoveryDiagnostics } from './discovery.js';
import { hrBrowserStep } from '../../../seek-bot/src/hr-browser-diagnostics.js';
const diagnostics:DiscoveryDiagnostics={stage:'company_pages',searches:0,pagesAttempted:1,pagesRead:1,pagesBlocked:0,pagesFailed:0,candidatesRejected:0,unresolvedPriorityPages:0,events:[]};
const contact:HiringContact={email:'careers@company.org',kind:'recruitment',companyDomain:'company.org',sourceUrl:'https://company.org/careers',sourceText:'Recruitment email',validatedAt:new Date().toISOString()};
const job:HrJob={id:'21',user_id:'1',application_id:'4',company_key:'company',dedupe_key:'hash',job_id:'4',platform:'seek',title:'Analyst',company:'Company',url:'https://company.org/jobs/4',cover_letter:'Approved letter',status:'researching',to_email:null,subject:null,body:null,contact:null,created_at:new Date(),lease:'lease',attempts:1,cost_usd:0};
function fixture(options:{fresh?:boolean;contact?:HiringContact|null;connected?:boolean;sendError?:Error;allowed?:boolean;uncertain?:boolean}={}){
  const events:any[]=[];
  const deps={store:{allowed:async()=>options.allowed!==false,setPhase:async(_job:HrJob,phase:string)=>{events.push(['phase',phase]);},cache:async()=>({contact:options.contact===null?null:contact,fresh:options.fresh!==false}),
    saveContact:async(...args:any[])=>events.push(['cache',...args]),draft:async(...args:any[])=>events.push(['draft',...args]),sending:async()=>{events.push(['sending']);return true;},
    finish:async(...args:any[])=>events.push(['finish',...args])},
    access:async()=>({connected:options.connected!==false}),profile:async()=>({fullName:'Test Candidate',headline:'Analyst',experienceSummary:'Reporting',skills:'SQL',highestQualification:'BSc'}),
    apiKey:()=> 'fixture-only',discover:async()=>{events.push(['discover']);return {contact:options.contact===null?null:contact,reason:'Published',pagesRead:1,retryable:false};},
    compose:async(input:any)=>{events.push(['compose',input]);return {subject:'My Analyst application',body:'I applied for the Analyst role. I have reporting experience.',costUsd:.01};},
    send:async(_user:any,mail:any)=>{events.push(['send',mail]);if(options.sendError)throw options.sendError;return {messageId:'receipt'};},
    reconcile:async()=>{events.push(['reconcile']);return options.uncertain?null:{messageId:'previous-receipt'};}
  } as unknown as HrWorkerDependencies;
  return {deps,events};
}

test('pre-send browser failure is stored and logged for inspection but customer history stays plain',async()=>{
 let original:unknown;try{await hrBrowserStep('mailbox_ready',async()=>{throw Object.assign(new Error('locator.waitFor: Timeout 30000ms exceeded.\nprivate mailbox contents'),{name:'TimeoutError'});});}catch(error){original=error;}
 const wrapped=Object.assign(new Error('The private Gmail browser was unavailable before sending.'),{cause:original,code:'unavailable',definitiveRejection:true});
 const {deps,events}=fixture({sendError:wrapped});
 deps.log=event=>events.push(['log',event]);deps.store.recordFailure=async(...args)=>{events.push(['failure',...args]);};
 await processHrJob({...job},deps);
 const logged=events.find(e=>e[0]==='log')[1];assert.equal(logged.browserFailure.step,'mailbox_ready');assert.equal(logged.browserFailure.category,'timeout');assert.match(logged.browserFailure.message,/Timeout 30000ms/);
 const stored=events.find(e=>e[0]==='failure');assert.deepEqual(stored[4],logged.browserFailure);
 assert.equal(events.at(-1)[2],'error');assert.equal(events.at(-1)[3],'The private browser could not open Gmail. This email was not sent.');
 assert.equal(events.filter(e=>e[0]==='send').length,1);assert.equal(events.at(-1)[6].retryable,true);assert.doesNotMatch(JSON.stringify(logged),/private mailbox contents/);
});
test('fresh shared contact is reused and exact delivered message saved before one send',async()=>{
  const {deps,events}=fixture();await processHrJob({...job},deps);
  assert.equal(events.filter(e=>e[0]==='discover').length,0);
  assert.equal(events.filter(e=>e[0]==='send').length,1);
  assert.deepEqual(events.filter(e=>e[0]==='phase').map(e=>e[1]),['researching','writing']);
  const draft=events.find(e=>e[0]==='draft'),send=events.find(e=>e[0]==='send');assert.equal(draft[4],send[1].body);assert.match(send[1].body,/Application reference: HR-/);
  assert.equal(events.at(-1)[2],'sent');
});

test('legacy cached suggestions receive agent selection once and cited contacts retain fast cross-run reuse',async()=>{
 const selected={...contact,evidenceQuotes:['Recruitment email']};
 const legacy=fixture();legacy.deps.research=async()=>{legacy.events.push(['agent']);return{contact:selected,reason:'Agent-selected public hiring contact',pagesRead:1,retryable:false,outcome:'found',diagnostics,costUsd:.001};};
 await processHrJob({...job},legacy.deps);assert.ok(legacy.events.some(event=>event[0]==='discover'));assert.ok(legacy.events.some(event=>event[0]==='agent'));assert.equal(legacy.events.at(-1)[2],'sent');
 const reused=fixture();reused.deps.store.cache=async()=>({contact:selected,fresh:true,reason:'Agent-selected public contact',outcome:'found',diagnostics});reused.deps.research=async()=>{throw Error('A fresh cited contact should be reused.');};
 await processHrJob({...job},reused.deps);assert.equal(reused.events.some(event=>event[0]==='discover'),false);assert.equal(reused.events.at(-1)[2],'sent');
});
test('expired contacts must revalidate before compose and sending',async()=>{
  const {deps,events}=fixture({fresh:false});await processHrJob({...job},deps);
  assert.ok(events.findIndex(e=>e[0]==='discover')<events.findIndex(e=>e[0]==='compose'));assert.equal(events.at(-1)[2],'sent');
});

test('agent-selected company fallback reaches drafting and the mock transport once and can be reused',async()=>{
 const selected:HiringContact={...contact,email:'info@company.org',kind:'company',sourceUrl:'https://company.org/contact',sourceText:'General company enquiries: info@company.org',evidenceQuotes:['General company enquiries: info@company.org']};
 const {deps,events}=fixture({fresh:false});
 deps.discover=async()=>({contact:null,reason:'No hiring inbox found.',pagesRead:1,retryable:false,outcome:'no_contact',diagnostics});
 deps.research=async()=>({contact:selected,reason:'Published general company email selected.',pagesRead:1,retryable:false,outcome:'found',diagnostics,costUsd:.001});
 await processHrJob({...job},deps);
 assert.equal(events.find(e=>e[0]==='compose')[1].contact.kind,'company');assert.equal(events.find(e=>e[0]==='send')[1].to,'info@company.org');assert.equal(events.filter(e=>e[0]==='send').length,1);assert.equal(events.at(-1)[2],'sent');
 const reused=fixture();reused.deps.store.cache=async()=>({contact:selected,fresh:true,reason:'Published general company email selected.',outcome:'found',diagnostics});
 reused.deps.research=async()=>{throw Error('Fresh company fallback should reuse its source-backed cache.');};
 await processHrJob({...job},reused.deps);assert.equal(reused.events.find(e=>e[0]==='compose')[1].contact.kind,'company');assert.equal(reused.events.filter(e=>e[0]==='send').length,1);
});
test('no public contact does not invent a recipient or send',async()=>{
  const {deps,events}=fixture({fresh:false,contact:null});await processHrJob({...job},deps);
  assert.equal(events.some(e=>e[0]==='send'||e[0]==='compose'),false);assert.equal(events.at(-1)[2],'skipped');
});
test('opt-out or corrected application stops all work',async()=>{
  const {deps,events}=fixture({allowed:false});await processHrJob({...job},deps);assert.equal(events.length,0);
});
test('unknown delivery is retained and never resubmitted on reconciliation',async()=>{
  const {deps,events}=fixture({sendError:new Error('Lost response')});await processHrJob({...job},deps);assert.equal(events.at(-1)[2],'unconfirmed');
  const next=fixture({uncertain:true});await processHrJob({...job,status:'unconfirmed',to_email:contact.email,subject:'Follow-up',body:'Original'},next.deps);
  assert.equal(next.events.some(e=>e[0]==='send'||e[0]==='compose'||e[0]==='discover'),false);assert.equal(next.events.at(-1)[2],'unconfirmed');
  assert.deepEqual(next.events.filter(e=>e[0]==='phase').map(e=>e[1]),['checking']);
});
test('receipt recovery marks sent without second send; disconnected Gmail remains unconfirmed',async()=>{
  const uncertain={...job,status:'unconfirmed' as const,to_email:contact.email,subject:'Follow-up',body:'Original'};
  const a=fixture();await processHrJob(uncertain,a.deps);assert.equal(a.events.at(-1)[2],'sent');assert.equal(a.events.some(e=>e[0]==='send'),false);
  const b=fixture({connected:false});await processHrJob(uncertain,b.deps);assert.equal(b.events.at(-1)[2],'unconfirmed');
});
test('definite pre-send rejection can retry; malformed generation costs retained with safe reason',async()=>{
  const a=fixture({sendError:Object.assign(new Error('secret provider body'),{definitiveRejection:true})});await processHrJob({...job},a.deps);assert.equal(a.events.at(-1)[2],'error');assert.doesNotMatch(a.events.at(-1)[3],/secret/);
  const b=fixture();b.deps.compose=async()=>{throw Object.assign(new Error('invalid result'),{costUsd:.02});};await processHrJob({...job},b.deps);assert.equal(b.events.at(-1)[5],.02);
});
test('a same-name company cache without job association forces fresh discovery',async()=>{
  const {deps,events}=fixture();deps.verifyContact=async()=>false;
  deps.discover=async(input)=>{assert.equal(input.previous,undefined,'unassociated cache cannot seed discovery');events.push(['discover']);return {contact:null,reason:'The employer website could not be verified.',pagesRead:1,retryable:false,outcome:'company_unverified',diagnostics};};
  await processHrJob({...job},deps);assert.equal(events.some(e=>e[0]==='send'),false);assert.equal(events.at(-1)[2],'skipped');
});
test('transient discovery failure does not poison the shared cache or mark permanently skipped',async()=>{
  const {deps,events}=fixture({fresh:false});deps.discover=async()=>({contact:null,reason:'The public search provider is temporarily unavailable.',pagesRead:1,retryable:true,outcome:'temporarily_unavailable',diagnostics});
  await processHrJob({...job},deps);assert.equal(events.some(e=>e[0]==='cache'||e[0]==='send'),false);assert.equal(events.at(-1)[2],'error');
});
test('new public vacancy evidence bypasses a company negative cache without exposing candidate evidence',async()=>{
  const {deps,events}=fixture({contact:null});
  let description='Company recruitment: careers@company.org',checks=0;
  deps.publicEvidence=async()=>({description,location:'Sydney NSW',sourceUrl:job.url,observedAt:'2026-11-16T00:00:00Z',sourceKind:'stored_vacancy'});
  deps.discover=async input=>{checks++;assert.equal(input.jobDescription,description);assert.equal(input.location,'Sydney NSW');assert.equal(input.jobDescriptionObservedAt,'2026-11-16T00:00:00Z');assert.equal('cover_letter'in input,false);
    return {contact:null,reason:'No suitable public contact.',pagesRead:1,retryable:false,outcome:'no_contact',diagnostics};};
  await processHrJob({...job},deps);assert.equal(checks,1,'an old company-wide negative cannot suppress a new job advertisement');
  const saved=events.find(e=>e[0]==='cache');const contextKey=saved.at(-1);assert.match(contextKey,/^[a-f0-9]{64}$/);
  deps.store.cache=async()=>({contact:null,fresh:true,reason:'No suitable public contact.',outcome:'no_contact',diagnostics,contextKey});
  await processHrJob({...job},deps);assert.equal(checks,1,'an unchanged vacancy can reuse its bounded negative lookup');
  description='Company recruitment now publishes talent@company.org';
  await processHrJob({...job},deps);assert.equal(checks,2,'changed public evidence receives a fresh lookup');
  assert.equal(events.some(e=>e[0]==='send'||e[0]==='compose'),false);
});
