import assert from 'node:assert/strict';
import { getPool,query } from './db/index.js';
import { adminAttention,removeAdminAttention,AttentionRemovalError } from './admin-attention.js';
import { loadAttention } from './attention.js';

// All tables shadow production tables in this connection. No real user data is changed.
const pool=getPool();pool.options.max=1;
try {
  await query(`CREATE TEMP TABLE run_events(id BIGSERIAL,user_id BIGINT,job_id TEXT,status TEXT,title TEXT,company TEXT,reason TEXT,url TEXT,ts TIMESTAMPTZ DEFAULT now(),questions JSONB,dismissed_at TIMESTAMPTZ)`);
  await query('CREATE TEMP TABLE applications(user_id BIGINT,job_id TEXT)');
  await query(`CREATE TEMP TABLE admin_attention_dismissals(actor_user_id BIGINT,user_id BIGINT,job_id TEXT,revision TEXT,event_ids BIGINT[])`);
  await query(`INSERT INTO run_events(user_id,job_id,status,title,reason,ts,questions) VALUES
    (1,'job','needs-human','First','INTERNAL_SECRET',now()-interval '2 minutes','[{"question":"DOB"}]'),
    (2,'job','needs-human','Other owner','INTERNAL_SECRET',now()-interval '2 minutes','[{"question":"DOB"}]'),
    (1,'other-job','needs-human','Other job',null,now()-interval '2 minutes','[{"question":"Another fact"}]')`);
  let first=(await adminAttention('1')).find(row=>row.jobId==='job')!;
  const other=(await adminAttention('2'))[0];
  assert.ok(!JSON.stringify(first).includes('INTERNAL_SECRET'));
  assert.notEqual(first.removalRevision,other.removalRevision,'versions are owner-bound');
  await assert.rejects(()=>removeAdminAttention('9','2',{jobId:'job',revision:first.removalRevision}),error=>error instanceof AttentionRemovalError&&error.status===409);
  await query(`UPDATE run_events SET questions='[{"question":"Changed question"}]' WHERE user_id=1 AND job_id='job'`);
  await assert.rejects(()=>removeAdminAttention('9','1',{jobId:'job',revision:first.removalRevision}),error=>error instanceof AttentionRemovalError&&error.status===409);
  first=(await adminAttention('1')).find(row=>row.jobId==='job')!;
  // A new event is guarded even if the task's visible text is unchanged.
  await query(`INSERT INTO run_events(user_id,job_id,status,title,ts,questions) SELECT user_id,job_id,status,title,now()-interval '1 minute',questions FROM run_events WHERE user_id=1 AND job_id='job'`);
  await assert.rejects(()=>removeAdminAttention('9','1',{jobId:'job',revision:first.removalRevision}));
  first=(await adminAttention('1')).find(row=>row.jobId==='job')!;
  const count=await query('SELECT * FROM run_events');
  const result=await removeAdminAttention('9','1',{jobId:'job',revision:first.removalRevision});
  assert.equal(result.removed,2);
  assert.deepEqual((await loadAttention('1')).map(item=>item.jobId),['other-job']);
  assert.equal((await loadAttention('2')).length,1,'other account untouched');
  assert.equal((await query('SELECT * FROM run_events')).length,count.length,'history retained');
  const audit=await query('SELECT * FROM admin_attention_dismissals');
  assert.equal(audit.length,1);assert.equal(String(audit[0].actor_user_id),'9');assert.equal(String(audit[0].user_id),'1');assert.equal(audit[0].event_ids.length,2);
  await assert.rejects(()=>removeAdminAttention('9','1',{jobId:'job',revision:first.removalRevision}));
  assert.equal((await query('SELECT * FROM admin_attention_dismissals')).length,1,'duplicate click cannot remove another row');
  await query(`INSERT INTO run_events(user_id,job_id,status,title,ts,questions) VALUES(1,'job','needs-human','A new question',clock_timestamp()+interval '1 second','[{"question":"New fact"}]')`);
  assert.ok((await loadAttention('1')).some(row=>row.jobId==='job'),'genuine later blocker reappears');
  const fresh=(await adminAttention('1')).find(row=>row.jobId==='job')!;
  await query('ALTER TABLE admin_attention_dismissals ADD CONSTRAINT fail_audit CHECK(false) NOT VALID');
  await assert.rejects(()=>removeAdminAttention('9','1',{jobId:'job',revision:fresh.removalRevision}));
  assert.ok((await loadAttention('1')).some(row=>row.jobId==='job'),'audit failure rolls removal back');
  await query('ALTER TABLE admin_attention_dismissals DROP CONSTRAINT fail_audit');
  await query(`CREATE TEMP TABLE users(id BIGINT,email TEXT,name TEXT,avatar_url TEXT,blocked_at TIMESTAMPTZ,created_at TIMESTAMPTZ,last_login_at TIMESTAMPTZ)`);
  await query(`CREATE TEMP TABLE sessions(token TEXT,user_id BIGINT,expires_at TIMESTAMPTZ)`);
  await query(`INSERT INTO users(id,email) VALUES(9,'admin@fixture.test'),(1,'normal@fixture.test'),(2,'target@fixture.test')`);
  await query(`INSERT INTO sessions VALUES('fixture-admin',9,now()+interval '1 hour'),('fixture-normal',1,now()+interval '1 hour')`);
  await query(`CREATE TEMP TABLE application_reviews(id UUID,user_id BIGINT,status TEXT,detail TEXT,payload JSONB,security_retry_after TIMESTAMPTZ,job_key TEXT,updated_at TIMESTAMPTZ)`);
  await query(`CREATE TEMP TABLE application_review_operator_holds(id UUID,user_id BIGINT,job_key TEXT,released_at TIMESTAMPTZ,draft_id UUID,revision TEXT,actor_user_id BIGINT,reason TEXT,held_at TIMESTAMPTZ)`);
  process.env.ADMIN_EMAILS='admin@fixture.test';
  const {handleAdminRequest}=await import('./admin.js');
  async function request(token:string,method:string,path:string,body:unknown={}){
    let result:{status:number;body:any}|undefined;
    await handleAdminRequest({method,headers:{cookie:`myasis_session=${token}`},on:()=>{}},{writeHead:()=>{},write:()=>{}},new URL(`http://fixture/api/admin${path}`),(body,status=200)=>{result={body,status};},async()=>body);
    return result!;
  }
  for(const method of ['GET','DELETE']){
    const path=method==='GET'?'/users/2/dashboard':'/users/2/attention';
    assert.equal((await request('',method,path)).status,401);
    assert.equal((await request('fixture-normal',method,path)).status,403,'ordinary owner cannot use admin routes');
  }
  const dashboard=await request('fixture-admin','GET','/users/2/dashboard');
  assert.equal(dashboard.status,200);assert.equal(dashboard.body.userId,'2');assert.equal(dashboard.body.attention.length,1);
  const removal=await request('fixture-admin','DELETE','/users/2/attention',{jobId:'job',revision:dashboard.body.attention[0].removalRevision,actorId:'1',userId:'1'});
  assert.equal(removal.status,200);assert.equal((await loadAttention('2')).length,0);
  assert.ok((await loadAttention('1')).length>0);
  assert.equal(String((await query('SELECT * FROM admin_attention_dismissals WHERE user_id=2'))[0].actor_user_id),'9','actor and target cannot be forged through the body');
  await query(`UPDATE users SET blocked_at=now() WHERE id=9`);
  assert.equal((await request('fixture-admin','GET','/users/2/dashboard')).status,401,'authorization is rechecked on every request');
  console.log('PASS owner isolation, changed questions/events, exact removal, history, audit, duplicate, recurrence and rollback');
} finally {await pool.end();}
