import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHrJob, type HrWorkerDependencies } from './worker.js';
import type { HrJob } from './store.js';
import type { DiscoveryResult, HiringContact } from './discovery.js';

const job:HrJob={id:'robustness-outreach',user_id:'fixture-owner',application_id:'fixture-application',company_key:'fixture',dedupe_key:'fixture-role',job_id:'fixture-job',platform:'seek',
  title:'Senior Software Engineer',company:'Fixture Technology Pty Ltd',url:'https://fixture.org/jobs/1',cover_letter:'Approved JavaScript and API experience.',status:'researching',to_email:null,subject:null,body:null,contact:null,
  created_at:'2026-11-16T00:00:00Z',lease:'fixture-lease',attempts:1,cost_usd:0};
const contact:HiringContact={email:'careers@fixture.org',kind:'recruitment',companyDomain:'fixture.org',sourceUrl:'https://fixture.org/careers',sourceText:'Fixture Technology recruitment team. Send applications to careers@fixture.org.',validatedAt:'2026-11-16T00:00:00Z',sourceKind:'public_page'};

function lookup(outcome:DiscoveryResult['outcome'],reason:string):DiscoveryResult {
  return {contact:null,outcome,reason,retryable:['temporarily_unavailable','incomplete'].includes(outcome),pagesRead:2,
    diagnostics:{stage:'company_pages',searches:1,pagesAttempted:2,pagesRead:2,pagesBlocked:outcome==='access_blocked'?1:0,pagesFailed:outcome==='temporarily_unavailable'?1:0,
      candidatesRejected:outcome==='company_unverified'?1:0,unresolvedPriorityPages:outcome==='incomplete'?1:0,events:[]}};
}
function fixture(result:DiscoveryResult){
  const events:Array<{kind:string;args:any[]}>=[],logs:any[]=[];
  const state={profileReads:0,compositions:0,sends:0,reconciliations:0};
  const deps={store:{allowed:async()=>true,setPhase:async(...args:any[])=>{events.push({kind:'phase',args});},cache:async()=>null,
      recordLookup:async(...args:any[])=>{events.push({kind:'lookup',args});},recordFailure:async(...args:any[])=>{events.push({kind:'diagnostic',args});},
      saveContact:async(...args:any[])=>{events.push({kind:'cache',args});},draft:async(...args:any[])=>{events.push({kind:'draft',args});},sending:async()=>true,
      finish:async(...args:any[])=>{events.push({kind:'finish',args});}},
    access:async()=>({connected:true}),apiKey:()=> 'fixture-key',profile:async()=>{state.profileReads++;return{fullName:'Taylor Candidate',headline:'Developer',experienceSummary:'JavaScript and APIs',skills:'JavaScript',highestQualification:'BSc'};},
    discover:async()=>result,verifyContact:async()=>true,
    compose:async()=>{state.compositions++;return{subject:'Application follow-up',body:'Hello hiring team, I applied for the software engineer role.',costUsd:.001};},
    send:async()=>{state.sends++;return{messageId:'fixture-receipt'};},reconcile:async()=>{state.reconciliations++;return null;},
    log:(event:any)=>{logs.push(event);},
  } as unknown as HrWorkerDependencies;
  const finished=()=>events.filter(event=>event.kind==='finish').at(-1)?.args;
  return{deps,events,logs,state,finished};
}

for(const [outcome,reason] of [
  ['no_contact','The verified employer does not publish a suitable recruitment contact.'],
  ['company_unverified','Public sources did not establish the employer website.'],
  ['access_blocked','The public contact source excludes automated access.'],
] as const)test(`terminal ${outcome} is reported accurately without writing or sending an email`,async()=>{
  const result=lookup(outcome,reason),run=fixture(result);await processHrJob({...job},run.deps);
  const finish=run.finished();assert.ok(finish);assert.equal(finish[1],'skipped');assert.equal(finish[2],reason);assert.notEqual(finish[5]?.retryable,true);
  assert.equal(run.events.find(event=>event.kind==='lookup')?.args[1].outcome,outcome);
  assert.equal(run.events.find(event=>event.kind==='lookup')?.args[1].reason,reason);
  assert.deepEqual(run.state,{profileReads:0,compositions:0,sends:0,reconciliations:0});assert.doesNotMatch(finish[2],/retry later|temporarily unavailable/i);
});

for(const outcome of ['temporarily_unavailable','incomplete'] as const)test(`${outcome} stays retryable and never becomes a false negative cache result`,async()=>{
  const reason=outcome==='incomplete'?'The contact lookup exhausted its bounded page allowance before verification.':'The public source is rate limited. Retry is scheduled.';
  const result=lookup(outcome,reason),run=fixture(result);await processHrJob({...job},run.deps);
  const finish=run.finished();assert.ok(finish);assert.equal(finish[1],'error');assert.equal(finish[2],reason);assert.equal(finish[5]?.retryable,true);
  assert.equal(run.events.find(event=>event.kind==='lookup')?.args[1].outcome,outcome);
  assert.equal(run.events.some(event=>event.kind==='cache'),false);assert.equal(run.state.compositions,0);assert.equal(run.state.sends,0);
});

test('fresh aggregator and disjoint-practice caches cannot bypass current employer/role assessment',async()=>{
  const invalidContacts:HiringContact[]=[
    {email:'hello@freehire.me',kind:'recruitment',companyDomain:'freehire.me',sourceUrl:'https://freehire.me/talent',sourceText:'Hiring? Request access Join the network',validatedAt:'2026-11-16T00:00:00Z',sourceKind:'public_page'},
    {email:'josh@lansonpartners.com',kind:'recruitment',companyDomain:'lansonpartners.com',sourceUrl:'https://www.lansonpartners.com/our-team',sourceText:'Josh Fordham, Senior Consultant – Finance & Treasury. Recruitment in the Treasury & Finance market.',validatedAt:'2026-11-16T00:00:00Z',sourceKind:'public_page'},
  ];
  for(const cached of invalidContacts){
    const result=lookup('company_unverified','No appropriate company recruiting contact was verified.'),run=fixture(result);
    run.deps.store.cache=async()=>({fresh:true,contact:cached,reason:'Old cached evidence',outcome:'found',diagnostics:lookup('found','Old cached evidence').diagnostics});
    let searches=0;run.deps.discover=async input=>{searches++;assert.equal(input.previous,undefined,'unfit cached contact cannot authorize or seed rediscovery');return result;};
    await processHrJob({...job,company:cached.email.startsWith('josh')?'Lanson Partners':'FiftyFive Group Pty Ltd'},run.deps);
    assert.equal(searches,1);assert.equal(run.state.compositions,0);assert.equal(run.state.sends,0);assert.equal(run.finished()?.[1],'skipped');
  }
});

test('unknown lookup errors retain an internal safe diagnostic and expose no provider payload or secrets',async()=>{
  const run=fixture(lookup('no_contact','Unused'));
  run.deps.discover=async()=>{throw Object.assign(new Error('SECRET_PROVIDER_TOKEN candidate-private@example.test raw mailbox body'),{code:'SECRET_PROVIDER_TOKEN'});};
  await processHrJob({...job},run.deps);
  assert.equal(run.finished()?.[1],'error');assert.equal(run.state.sends,0);
  const diagnostics=run.events.filter(event=>event.kind==='diagnostic');assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].args[1],'researching');
  assert.equal(run.logs.length,1);assert.deepEqual(Object.keys(run.logs[0]).sort(),['code','jobId','stage']);assert.equal(run.logs[0].jobId,job.id);assert.equal(run.logs[0].stage,'researching');
  assert.match(run.logs[0].code,/^[a-z0-9_:-]{1,100}$/i);
  assert.doesNotMatch(JSON.stringify({events:run.events,logs:run.logs}),/SECRET_PROVIDER_TOKEN|candidate-private|raw mailbox body/);
});

test('writing failure preserves measured charge and reports its actual stage without leaking draft content',async()=>{
  const result={...lookup('found','Published recruitment contact.'),contact},run=fixture(result);
  run.deps.compose=async()=>{throw Object.assign(new Error('SECRET_COMPOSITION_PAYLOAD'),{costUsd:.006});};
  await processHrJob({...job},run.deps);
  const finish=run.finished();assert.equal(finish?.[1],'error');assert.equal(finish?.[4],.006);assert.equal(run.state.sends,0);
  assert.equal(run.events.find(event=>event.kind==='diagnostic')?.args[1],'writing');assert.equal(run.logs[0]?.stage,'writing');
  assert.doesNotMatch(JSON.stringify({events:run.events,logs:run.logs}),/SECRET_COMPOSITION_PAYLOAD/);
});

test('uncertain delivery remains reconciliation-only even when historical contact quality is now rejected',async()=>{
  const run=fixture(lookup('company_unverified','Must not rediscover'));
  run.deps.discover=async()=>{throw Error('An uncertain send must not discover or replace its recipient');};
  run.deps.compose=async()=>{throw Error('An uncertain send must preserve its original content');};
  await processHrJob({...job,status:'unconfirmed',to_email:'hello@freehire.me',subject:'Original follow-up',body:'Original exact message'},run.deps);
  assert.equal(run.state.reconciliations,1);assert.equal(run.state.sends,0);assert.equal(run.finished()?.[1],'unconfirmed');
});
