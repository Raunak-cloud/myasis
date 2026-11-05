import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';
import { accountApplicationEnvironment } from './runner.js';
import { validOperatorApplicationBudget } from './operator-application-budget.js';

const pool=getPool(); after(async()=>{await pool.end();});
test('one-time application spending requires the exact recorded unfinished owner-bound admin authorization',async()=>{
  const original=pool.query,keys=['ADMIN_EMAILS','CELERIS_API_KEY'] as const;
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{ADMIN_EMAILS:'admin@fixture.invalid',CELERIS_API_KEY:'fixture-only'});
  let actor='admin@fixture.invalid',recorded:unknown={baseUsd:2,maximumUsd:4};
  pool.query=(async(sql:string,params:unknown[])=>{
    if(sql.includes('application_model_assignments'))return{rows:[]};
    if(sql.includes('FROM run_starts')){
      assert.match(sql,/run.user_id=\$2/);assert.match(sql,/run.finished_at IS NULL/);assert.match(sql,/run.mode='live'/);assert.match(sql,/run.trigger='admin'/);
      return{rows:params[0]==='authorized'&&params[1]==='customer'?[{email:actor,operator_options:{applicationBudget:recorded}}]:[]};
    }
    return{rows:[{id:params[0],email:'candidate@fixture.invalid'}]};
  }) as typeof original;
  const settings={OPERATOR_APPLICATION_BASE_USD:'2',OPERATOR_APPLICATION_MAXIMUM_USD:'4'};
  try {
    const allowed=await accountApplicationEnvironment('customer',settings,'authorized');
    assert.equal(allowed.AGENT_BUDGET_USD,'2');assert.equal(allowed.AGENT_PROGRESS_BUDGET_USD,'4');
    await assert.rejects(accountApplicationEnvironment('customer',settings),/budget authorization/);
    await assert.rejects(accountApplicationEnvironment('customer',settings,'other-run'),/budget authorization/);
    await assert.rejects(accountApplicationEnvironment('other-owner',settings,'authorized'),/budget authorization/);
    await assert.rejects(accountApplicationEnvironment('customer',{...settings,OPERATOR_APPLICATION_BASE_USD:'3'},'authorized'),/budget authorization/);
    actor='candidate@fixture.invalid';await assert.rejects(accountApplicationEnvironment('customer',settings,'authorized'),/budget authorization/);
    actor='admin@fixture.invalid';recorded={baseUsd:2,maximumUsd:11};await assert.rejects(accountApplicationEnvironment('customer',settings,'authorized'),/budget authorization/);
    const ordinary=await accountApplicationEnvironment('customer',{},'authorized');
    assert.equal(ordinary.AGENT_BUDGET_USD,undefined);assert.equal(ordinary.AGENT_PROGRESS_BUDGET_USD,undefined,'no override leaks to a subsequent run');
    assert.deepEqual(settings,{OPERATOR_APPLICATION_BASE_USD:'2',OPERATOR_APPLICATION_MAXIMUM_USD:'4'});
  }finally{pool.query=original;for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
});
test('spending bounds reject invalid, inverted and excessive budgets',()=>{
  for(const value of [null,{},[],{baseUsd:'2',maximumUsd:4},{baseUsd:0,maximumUsd:4},{baseUsd:NaN,maximumUsd:4},{baseUsd:2,maximumUsd:Infinity},{baseUsd:4,maximumUsd:2},{baseUsd:2,maximumUsd:10.01}])assert.equal(validOperatorApplicationBudget(value),false);
  assert.equal(validOperatorApplicationBudget({baseUsd:2,maximumUsd:4}),true);
});
