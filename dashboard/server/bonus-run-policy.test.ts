import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {getPool} from './db/index.js';
import {bonusRunOptions,bonusRunAllowance,bonusSalaryFloor} from './bonus-run-policy.js';
import {bonusRunEnvironment} from './bonus-runs.js';
import type {BillingStatus} from './billing.js';

const pool=getPool();after(async()=>{await pool.end();});
test('bonus runs use a bounded complimentary projection without changing plan, credits or salary preferences',()=>{
 const options=bonusRunOptions({maxApplications:10,applicationMode:'auto',salaryDiscountPercent:10,message:'A bonus run.'});
 const billing={free:{allowance:5,used:5,remaining:0},paid:{remaining:0,employerSiteRemaining:0,hasActivePass:false,hasActiveIntensivePass:false},totalRemaining:0} as BillingStatus;
 const before=structuredClone(billing),saved={MIN_SALARY:'140000',MIN_SCORE:'70',MAX_AGE_DAYS:'10',WORK_ARRANGEMENTS:'remote,hybrid'};
 const allowance=bonusRunAllowance(billing,options.maxApplications);
 assert.equal(allowance.totalRemaining,10);assert.equal(allowance.paid.remaining,10);assert.equal(allowance.paid.hasActiveIntensivePass,false,'a bonus is not a plan or source upgrade');assert.deepEqual(billing,before);
 assert.equal(bonusSalaryFloor(saved.MIN_SALARY,options.salaryDiscountPercent),'126000');assert.equal(saved.MIN_SALARY,'140000');assert.equal(saved.MIN_SCORE,'70');assert.equal(saved.MAX_AGE_DAYS,'10');
 assert.equal(bonusSalaryFloor('140001',10),'126001','round upward so the authorized salary reduction is never exceeded');assert.equal(bonusSalaryFloor('140000',0),'140000');
 for(const extra of [{salaryDiscountPercent:10.01},{salaryDiscountPercent:-1},{maxApplications:0},{maxApplications:51},{applicationMode:'automatic'},{message:'x'.repeat(241)},{MIN_SCORE:0}])assert.throws(()=>bonusRunOptions({...options,...extra}));
});
test('a worker cannot forge bonus authority, target another owner or alter the recorded run salary',async()=>{
 const original=pool.query,oldAdmins=process.env.ADMIN_EMAILS;process.env.ADMIN_EMAILS='admin@bonus.fixture.invalid';
 const id='d30c85ba-35c1-4e04-9698-7db24ce015b7';
 const settings={BONUS_RUN_ID:id,MAX_APPS_PER_RUN:'10',MIN_SALARY:'126000'};
 let actor='admin@bonus.fixture.invalid';
 pool.query=(async(sql:string,params:unknown[])=>{
  assert.match(sql,/b.user_id=\$2/);assert.match(sql,/r.id=\$3/);assert.match(sql,/r.finished_at IS NULL/);assert.match(sql,/r.started_by=b.started_by/);
  return {rows:params[0]===id&&params[1]==='183'&&params[2]==='1300'?[{email:actor,max_applications:10,operator_options:{bonusRunId:id,complimentary:true,minimumSalary:'126000'}}]:[]};
 }) as typeof original;
 try{
  assert.deepEqual(await bonusRunEnvironment('183',undefined,{}),{BONUS_RUN_ID:''});
  await assert.rejects(bonusRunEnvironment('183',undefined,settings),/recorded administrator/);
  assert.deepEqual(await bonusRunEnvironment('183','1300',settings),{BONUS_RUN_ID:id});
  await assert.rejects(bonusRunEnvironment('other','1300',settings),/matching administrator/);
  await assert.rejects(bonusRunEnvironment('183','other-run',settings),/matching administrator/);
  await assert.rejects(bonusRunEnvironment('183','1300',{...settings,MIN_SALARY:'125999'}),/matching administrator/);
  await assert.rejects(bonusRunEnvironment('183','1300',{...settings,MAX_APPS_PER_RUN:'11'}),/matching administrator/);
  actor='candidate@bonus.fixture.invalid';await assert.rejects(bonusRunEnvironment('183','1300',settings),/matching administrator/);
 }finally{pool.query=original;if(oldAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldAdmins;}
});
