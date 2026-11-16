import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool, type query } from '../db/index.js';
import { insertApplicationRow } from '../db/records.js';
import { syncRunResultsToDb } from '../db/run-sync.js';
import { RunPool } from '../runner.js';
import { completeHrRun, type HrRunCompletion } from './run-completion.js';

const done: HrRunCompletion = { browserReleased: true, descendantsReleased: true, resultsSaved: true, recorded: true };
const pool=getPool();after(async()=>{await pool.end();});

test('HR completion requires every durable boundary and wakes only after owner-bound finished-run update',async()=>{
  let writes=0,wakes=0;
  const deps={write:(async(sql:string,params:unknown[])=>{writes++;assert.match(sql,/user_id=\$2.*finished_at IS NOT NULL/s);assert.deepEqual(params,['99','7']);return [{id:'99'}];}) as typeof query,
    wake:()=>{assert.equal(writes,1);wakes++;}};
  assert.equal(await completeHrRun('7',null,done,deps),false);
  assert.equal(await completeHrRun('7','99',{} as HrRunCompletion,deps),false);
  for(const flag of Object.keys(done))assert.equal(await completeHrRun('7','99',{...done,[flag]:false},deps),false);
  assert.equal(writes,0);assert.equal(wakes,0);
  assert.equal(await completeHrRun('7','99',done,deps),true);assert.equal(wakes,1);
  assert.equal(await completeHrRun('7','99',done,{...deps,write:(async()=>[]) as typeof query}),false,'missing, foreign, unfinished or already-ready runs cannot wake');
  await assert.rejects(completeHrRun('7','99',done,{...deps,write:async()=>{throw Error('Database unavailable');}}),/Database unavailable/);
  assert.equal(wakes,1);
});

test('sync attributes only new inserts to server source run; historical/conflicting rows and unbound recoveries stay untouched',async()=>{
  const original=pool.query,dir=mkdtempSync(join(tmpdir(),'owtomate-hr-origin-'));
  const stored=new Map<string,{source:string|null;confirmed:boolean}>([['historical',{source:null,confirmed:true}],['earlier-run',{source:'98',confirmed:true}]]);
  pool.query=(async(sql:string,params:any[]=[])=>{
    assert.match(sql,/INSERT INTO applications/);assert.match(sql,/ON CONFLICT \(user_id, platform, job_id\) DO NOTHING/);
    if(params.length===24)assert.match(sql,/SELECT id FROM run_starts WHERE id=\$24 AND user_id=\$1/);
    if(stored.has(params[1]))return {rows:[]};
    stored.set(params[1],{source:params[23]??null,confirmed:params[22]===null});return {rows:[{id:params[1]}]};
  }) as typeof original;
  try{
    const row=(jobId:string)=>({jobId,title:'Analyst',company:'Fixture',score:80,submittedByMyasis:true});
    writeFileSync(join(dir,'applied.json'),JSON.stringify([row('historical'),row('earlier-run'),{...row('new-job'),sourceRunId:'attacker-run'},{...row('uncertain'),confirmationStatus:'unconfirmed'}]));
    assert.equal((await syncRunResultsToDb('7',dir,'99')).resultsSaved,true);
    assert.equal(stored.get('historical')!.source,null);assert.equal(stored.get('earlier-run')!.source,'98');
    assert.equal(stored.get('new-job')!.source,'99');assert.equal(stored.get('uncertain')!.confirmed,false);
    await insertApplicationRow('7',row('recovery-without-run'));assert.equal(stored.get('recovery-without-run')!.source,null);
    await assert.rejects(insertApplicationRow('7',row('bad-id'),'invalid'),/Invalid application source run/);
    writeFileSync(join(dir,'applied.json'),'broken JSON');assert.equal((await syncRunResultsToDb('7',dir,'99')).resultsSaved,false);
    writeFileSync(join(dir,'applied.json'),JSON.stringify([row('database-failure')]));
    pool.query=(async()=>{throw Error('Write failed');}) as typeof original;
    assert.equal((await syncRunResultsToDb('7',dir,'99')).resultsSaved,false,'swallowed legacy sync errors must still block HR readiness');
  }finally{pool.query=original;rmSync(dir,{recursive:true,force:true});}
});

test('actual runner finalization holds HR until sync, post-run work and finish record settle, then releases the slot before readiness',async()=>{
  const original=pool.query,dir=mkdtempSync(join(tmpdir(),'owtomate-hr-finalize-'));
  try{
    for(const scenario of ['stopped-confirmed','sync-failure','finish-failure','cleanup-reject'] as const){
      const runs=new RunPool(),run=Reflect.get(runs,'forUser').call(runs,'hr-completion-fixture');
      const events:string[]=[];
      let release!:()=>void,started!:()=>void;
      const cleanupStarted=new Promise<void>(resolve=>{started=resolve;}),cleanup=new Promise<void>(resolve=>{release=resolve;});
      run.runStartId='99';run.emailOnlyRun=true;run.stoppedByPerson=true;run.state.running=true;
      run.push=()=>{};run.onFinished=async()=>{events.push('cleanup');started();await cleanup;if(scenario==='cleanup-reject')throw Error('Post-run cleanup failed');};
      run.recordFinish=async()=>{events.push('record');assert.equal(run.occupiesSlot,true);if(scenario==='finish-failure')throw Error('No finish record');return true;};
      writeFileSync(join(dir,'applied.json'),scenario==='sync-failure'?'broken JSON':'[]');
      pool.query=(async(sql:string)=>{if(sql.includes('SET hr_ready_at')){assert.equal(run.occupiesSlot,false);assert.deepEqual(events,['cleanup','record']);events.push('ready');return {rows:[{id:'99'}]};}return {rows:[]};}) as typeof original;
      const finished=run.finishChild('hr-completion-fixture',dir,'run',143,{},'SIGTERM');
      await cleanupStarted;assert.equal(events.includes('ready'),false);assert.equal(run.occupiesSlot,true);
      release();await finished;
      assert.equal(run.occupiesSlot,false);
      assert.equal(events.includes('ready'),scenario==='stopped-confirmed','confirmed submissions from a stopped run remain eligible after a complete finish; failures remain ineligible');
    }
  }finally{pool.query=original;rmSync(dir,{recursive:true,force:true});}
});
