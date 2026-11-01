import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairRetryTick } from './repair-retries.js';
import type { query } from './db/index.js';

test('retry consumer launches one scoped preparation and blocks stopped, changed-mode and uncertain attempts',async()=>{
  const id='00000000-0000-4000-8000-000000000001',attempt='00000000-0000-4000-8000-000000000002';
  for(const scenario of ['prepare','stopped','uncertain','changed-mode','existing','question','paused','claimed-elsewhere','refused'] as const){
    const writes:Array<{sql:string;params:any[]|undefined}>=[],starts:any[]=[];
    const row={id,run_id:'100',attempt_id:attempt,created_at:new Date(),email:'raunak.vision@gmail.com',finished_at:new Date(),stopped:scenario==='stopped',trigger:'auto',schedule_enabled:true,schedule_mode:scenario==='changed-mode'?'auto':'semi-auto'};
    const trace={runStartId:'100',attemptId:attempt,jobId:'fixture',job:{id:'fixture',platform:'indeed',title:'Developer',company:'Fixture',url:'https://fixture.invalid/job/1'},mode:'prepare',outcome:{status:'skipped'},sendAudit:{attempted:scenario==='uncertain'},steps:[{tool:'browser_action',args:{action:'fill'},completedAt:'now'}]};
    const db=(async(sql:string,params:any[])=>{
      if(sql.includes('FROM repair_pilot_cases c'))return [row];
      if(sql.startsWith('SELECT 1 FROM applications'))return scenario==='existing'?[{}]:[];
      if(sql.startsWith('SELECT 1 FROM run_events'))return scenario==='question'?[{}]:[];
      if(sql.startsWith('SELECT 1 FROM run_starts'))return [];
      writes.push({sql,params});
      return sql.includes('RETURNING id')&&scenario!=='claimed-elsewhere'?[{id}]:[];
    }) as typeof query;
    await repairRetryTick({query:db,runner:{inUse:()=>false,runIdFor:()=> '101'},enabled:()=>scenario!=='paused',deploying:()=>false,isAdmin:()=>true,readTrace:()=>trace,
      startRun:async request=>{starts.push(request);return scenario==='refused'?{ok:false,status:409,error:'Busy'}:{ok:true,mode:'live'};}});
    const launched=['prepare','refused'].includes(scenario);
    assert.equal(starts.length,launched?1:0,scenario);
    if(launched){assert.equal(starts[0].userId,'1');assert.equal(starts[0].applicationMode,'semi-auto');assert.equal(starts[0].repairJob.id,'fixture');assert.equal(starts[0].repairCaseId,id);assert.equal(starts[0].approvals,undefined);}
    if(scenario==='refused')assert.ok(writes.some(w=>w.params?.[1]==='blocked'));
  }
});
