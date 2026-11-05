import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';
import { accountApplicationEnvironment } from './runner.js';
import { sponsoredRunAllowance, sponsoredRunEntitlements } from './operator-run-plan.js';
import { deriveEntitlements } from './entitlements.js';
import { startRun } from './start-run.js';
import type { BillingStatus } from './billing.js';

const pool=getPool();
after(async()=>{await pool.end();});
const billing:BillingStatus={configured:false,free:{allowance:5,used:2,remaining:3},paid:{remaining:0,employerSiteRemaining:0,expiresAt:null,hasActivePass:false,hasActiveEssentialPass:false,hasActiveJobSearchPass:false,hasActiveIntensivePass:false},totalRemaining:3};

test('sponsored run leaves the real plan, free credits and schedule unchanged',()=>{
 const current=deriveEntitlements({admin:false,billing,overrides:{evaluationsPerRun:null,maxApplicationsPerRun:null},autoRunsUsedToday:1,autoApplyPaused:false,hasSuccessfulRun:true,searchTermSuggestionsLeft:1});
 const before=structuredClone({billing,current});
 const sponsored=sponsoredRunEntitlements(current), allowance=sponsoredRunAllowance(billing);
 assert.equal(sponsored.tier,'intensive');assert.equal(sponsored.evaluationsPerRun,400);
 assert.equal(sponsored.autoRunsPerDay,current.autoRunsPerDay);assert.equal(sponsored.autoRunsUsedToday,1);
 assert.equal(allowance.totalRemaining,100);assert.equal(allowance.paid.employerSiteRemaining,30);
 assert.deepEqual({billing,current},before);
});

test('review and timeout exception requires an unfinished owner-bound administrator run',async()=>{
 const originalQuery=pool.query, names=['ADMIN_EMAILS','CELERIS_API_KEY'] as const;
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.ADMIN_EMAILS='operator@fixture.invalid';process.env.CELERIS_API_KEY='fixture-only-key';
 let actor='operator@fixture.invalid', options={plan:'intensive-pass',complimentary:true,maxEvaluations:400,timeoutMinutes:120};
 pool.query=(async(sql:string,params:unknown[])=>{
  if(sql.includes('FROM application_model_assignments'))return {rows:[]};
  if(sql.includes('FROM run_starts')){
   assert.match(sql,/run.user_id=\$2/);assert.match(sql,/run.finished_at IS NULL/);assert.match(sql,/run.trigger='admin'/);
   return {rows:params[0]==='authorized'?[{email:actor,operator_options:options}]:[]};
  }
  return {rows:[{id:params[0],email:'candidate@fixture.invalid'}]};
 }) as typeof originalQuery;
 try{
  const settings={OPERATOR_PLAN:'intensive-pass'};
  await assert.rejects(accountApplicationEnvironment('owner',settings),/recorded administrator/);
  await assert.rejects(accountApplicationEnvironment('owner',settings,'other-run'),/no valid administrator/);
  const authorized=await accountApplicationEnvironment('owner',settings,'authorized');
  assert.equal(authorized.OPERATOR_MAX_EVALUATIONS,'400');assert.equal(authorized.OPERATOR_RUN_TIMEOUT_MINUTES,'120');
  const ordinary=await accountApplicationEnvironment('owner',{},'authorized');
  assert.equal(ordinary.OPERATOR_MAX_EVALUATIONS,'');assert.equal(ordinary.OPERATOR_RUN_TIMEOUT_MINUTES,'');
  actor='candidate@fixture.invalid';await assert.rejects(accountApplicationEnvironment('owner',settings,'authorized'),/no valid administrator/);
  actor='operator@fixture.invalid';options={...options,maxEvaluations:401};
  await assert.rejects(accountApplicationEnvironment('owner',settings,'authorized'),/no valid administrator/);
 }finally{pool.query=originalQuery;for(const name of names)if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}
});

test('only verified live admin starts accept a 400-review sponsorship; 401 and ordinary 400 are refused',async()=>{
 const originalQuery=pool.query, prior=process.env.ADMIN_EMAILS;
 process.env.ADMIN_EMAILS='operator@fixture.invalid';let operator=true;
 pool.query=(async(sql:string)=>{
  assert.match(sql.trim(),/^(SELECT|WITH)/,'validation must not write account settings or billing');
  if(sql.includes('SELECT email FROM users'))return {rows:[{email:operator?'operator@fixture.invalid':'candidate@fixture.invalid'}]};
  if(sql.includes('FROM monthly_application_usage'))return {rows:[{used:'2'}]};
  if(sql.includes('FROM run_starts')||sql.includes('FROM feature_uses')||sql.includes('FROM applications'))return {rows:[{n:'0',complete:false}]};
  if(sql.includes('SELECT * FROM profiles'))return {rows:[{expected_salary:'90000'}]};
  if(sql.includes('FROM resumes')||sql.includes('FROM settings')||sql.includes('FROM application_schedules')||sql.includes('FROM account_overrides')||sql.includes('application_credit_grants'))return {rows:[]};
  throw new Error('Unexpected validation query');
 }) as typeof originalQuery;
 try{
  const request={userId:'fixture-vip',mode:'live' as const,trigger:'admin' as const,startedBy:'1',oneTime:{plan:'intensive-pass' as const,maxApplications:50,maxEvaluations:400}};
  const accepted=await startRun(request);assert.ok(!accepted.ok && /Upload your resume/.test(accepted.error),'authorized sponsorship retains document setup checks');
  for(const change of [{oneTime:{...request.oneTime,maxEvaluations:401}},{oneTime:{maxEvaluations:400}},{startedBy:undefined},{mode:'search' as const},{applicationMode:'semi-auto' as const}]){
   const result=await startRun({...request,...change});assert.ok(!result.ok && [400,403].includes(result.status));
  }
  operator=false;const forged=await startRun(request);assert.ok(!forged.ok&&forged.status===403);
 }finally{pool.query=originalQuery;if(prior===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=prior;}
});
