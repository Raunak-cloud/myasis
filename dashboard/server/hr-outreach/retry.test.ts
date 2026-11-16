import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPool } from '../db/index.js';
import { retryHrOutreachForRun } from './retry.js';

test('invalid retry identities are rejected without connecting',async()=>{
  let calls=0;const options={connect:async()=>{calls++;throw Error('No database expected');}};
  for(const [user,run] of [['0','10'],['1','other'],['foreign','10']])await assert.rejects(retryHrOutreachForRun(user,run,options),/valid account/);
  for(const ids of [[],['1','1'],['bad']])await assert.rejects(retryHrOutreachForRun('1','10',{...options,expectedIds:ids}),/valid HR/);
  assert.equal(calls,0);
});

test('real PostgreSQL retry is owner/admin/run scoped, never dispatches, preserves uncertain sends and rolls back atomically',async()=>{
  const originalAdmins=process.env.ADMIN_EMAILS;process.env.ADMIN_EMAILS='hr-retry-admin@example.test';
  const client=await getPool().connect();
  const options={connect:async()=>({query:(text:string,params?:any[])=>client.query(text,params),release:()=>{}})};
  try{
    await client.query(`CREATE TEMP TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);
      CREATE TEMP TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT,finished_at TIMESTAMPTZ,hr_ready_at TIMESTAMPTZ);
      CREATE TEMP TABLE hr_outreach_preferences(user_id BIGINT PRIMARY KEY,enabled BOOLEAN,enabled_since TIMESTAMPTZ);
      CREATE TEMP TABLE applications(id BIGINT PRIMARY KEY,user_id BIGINT,source_run_id BIGINT,submitted_by_myasis BOOLEAN,confirmation_status TEXT,outcome TEXT,applied_at TIMESTAMPTZ);
      CREATE TEMP TABLE hr_outreach(id BIGINT PRIMARY KEY,user_id BIGINT,application_id BIGINT,company_key TEXT,title TEXT,company TEXT,status TEXT,phase TEXT,reason TEXT,
        send_started_at TIMESTAMPTZ,message_id TEXT,thread_id TEXT,sent_at TIMESTAMPTZ,to_email TEXT,subject TEXT,body TEXT,lease TEXT,lease_until TIMESTAMPTZ,
        attempts INTEGER,available_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      CREATE TEMP TABLE hr_company_contacts(company_key TEXT PRIMARY KEY,contact JSONB,next_validation_at TIMESTAMPTZ);
      INSERT INTO users VALUES(1,'hr-retry-admin@example.test',NULL),(2,'hr-retry-admin@example.test',NULL),(3,'ordinary@example.test',NULL);
      INSERT INTO hr_outreach_preferences VALUES(1,true,now()-interval '1 day'),(2,true,now()-interval '1 day'),(3,true,now()-interval '1 day');
      INSERT INTO run_starts VALUES(10,1,now(),now()),(12,1,now(),now()),(20,2,now(),now()),(30,3,now(),now());
      INSERT INTO applications SELECT n,1,10,true,NULL,NULL,now() FROM generate_series(1,17) n;
      INSERT INTO hr_outreach(id,user_id,application_id,company_key,title,company,status,reason,attempts,available_at)
        SELECT n,1,n,CASE WHEN n=2 THEN 'negative' ELSE 'positive' END,'Role '||n,'Fixture','error','Public contact lookup is temporarily unavailable. It will retry later.',2,now()+interval '30 minutes' FROM generate_series(1,17) n;
      UPDATE hr_outreach SET status='skipped',reason='No publicly listed hiring or recruitment email was found.' WHERE id=2;
      UPDATE hr_outreach SET status='unconfirmed' WHERE id=3;
      UPDATE hr_outreach SET status='sending' WHERE id=4;
      UPDATE hr_outreach SET status='sent' WHERE id=5;
      UPDATE hr_outreach SET send_started_at=now() WHERE id=6;
      UPDATE hr_outreach SET message_id='existing-receipt' WHERE id=7;
      UPDATE hr_outreach SET sent_at=now() WHERE id=8;
      UPDATE hr_outreach SET to_email='careers@example.test',subject='Prepared',body='Prepared body' WHERE id=9;
      UPDATE hr_outreach SET reason='HR outreach could not finish. It will retry later.' WHERE id=10;
      UPDATE applications SET user_id=2,source_run_id=20 WHERE id=11;
      UPDATE hr_outreach SET user_id=2 WHERE id=11;
      UPDATE applications SET confirmation_status='unconfirmed' WHERE id=12;
      UPDATE applications SET source_run_id=20 WHERE id=13;
      UPDATE applications SET outcome='closed' WHERE id=14;
      UPDATE hr_outreach SET lease='active',lease_until=now()+interval '5 minutes' WHERE id=15;
      UPDATE applications SET source_run_id=12 WHERE id=16;
      UPDATE hr_outreach SET thread_id='existing-thread' WHERE id=17;
      INSERT INTO hr_company_contacts VALUES('positive','{"email":"careers@example.test"}',now()+interval '1 month'),('negative',NULL,now()+interval '1 day');`);
    for(const [user,run] of [['1','20'],['3','30']])await assert.rejects(retryHrOutreachForRun(user,run,options),/administrator HR retry/);
    await client.query('UPDATE run_starts SET hr_ready_at=NULL WHERE id=10');
    await assert.rejects(retryHrOutreachForRun('1','10',options),/completed run/);await client.query('UPDATE run_starts SET hr_ready_at=now() WHERE id=10');
    await client.query('UPDATE hr_outreach_preferences SET enabled=false WHERE user_id=1');
    await assert.rejects(retryHrOutreachForRun('1','10',options),/administrator HR retry/);await client.query('UPDATE hr_outreach_preferences SET enabled=true WHERE user_id=1');
    await assert.rejects(retryHrOutreachForRun('1','10',{...options,expectedIds:['1','2','3']}),/records changed/);
    assert.equal((await client.query('SELECT attempts FROM hr_outreach WHERE id=1')).rows[0].attempts,2);
    const before=(await client.query('SELECT id,status,attempts FROM hr_outreach ORDER BY id')).rows;
    const result=await retryHrOutreachForRun('1','10',{...options,expectedIds:['1','2']});
    assert.equal(result.requeued,2);assert.deepEqual(result.items.map(row=>row.id),['1','2']);
    const after=(await client.query('SELECT id,status,attempts FROM hr_outreach ORDER BY id')).rows;
    assert.deepEqual(after.slice(2),before.slice(2),'uncertain, sending, sent, attempted, drafted, foreign, active and unrelated rows remain untouched');
    assert.ok(after.slice(0,2).every(row=>row.status==='queued'&&row.attempts===0));
    const cache=(await client.query('SELECT company_key, next_validation_at<=now() AS expired FROM hr_company_contacts ORDER BY company_key')).rows;
    assert.deepEqual(cache,[{company_key:'negative',expired:true},{company_key:'positive',expired:false}]);
    assert.equal((await retryHrOutreachForRun('1','10',options)).requeued,0,'repeating the request cannot create new outreach rows');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM applications')).rows[0].count,17,'no new applications or credit usage are created');
    await client.query("UPDATE hr_outreach SET status='error',reason='Public contact lookup is temporarily unavailable. It will retry later.',attempts=2 WHERE id IN(1,2)");
    await assert.rejects(retryHrOutreachForRun('1','10',{connect:async()=>({release:()=>{},query:(text,params)=>{
      if(text.startsWith('UPDATE hr_company_contacts'))throw Error('Synthetic cache write failure');return client.query(text,params);
    }})}),/Synthetic cache write failure/);
    assert.ok((await client.query('SELECT status,attempts FROM hr_outreach WHERE id IN(1,2)')).rows.every(row=>row.status==='error'&&row.attempts===2),'queue and cache update roll back together');
  }finally{
    client.release();await getPool().end();if(originalAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=originalAdmins;
  }
});
