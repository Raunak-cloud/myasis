import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPool } from '../db/index.js';
import { HrStore,companyKey,outreachKey,getHrOutreachSettings,setHrOutreachEnabled,listHrOutreach,listHrOutreachPage,hrOutreachProgress } from './store.js';
import type { HiringContact } from './discovery.js';

const oldAdmins=process.env.ADMIN_EMAILS;process.env.ADMIN_EMAILS='admin-one@example.test,admin-two@example.test';
const client=await getPool().connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ);
    CREATE TEMP TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,finished_at TIMESTAMPTZ);
    CREATE TEMP TABLE application_email_sends(id BIGINT PRIMARY KEY);
    CREATE TEMP TABLE applications(id BIGINT PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,job_id TEXT,platform TEXT,title TEXT,company TEXT,url TEXT,cover_letter TEXT,
      submitted_by_myasis BOOLEAN,confirmation_status TEXT,outcome TEXT,applied_at TIMESTAMPTZ,location TEXT);
    INSERT INTO users VALUES(1,'admin-one@example.test',NULL),(2,'admin-two@example.test',NULL),(3,'admin-one@example.test',now()),(4,'ordinary@example.test',NULL);`);
  await client.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8').replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE IF NOT EXISTS'));
  await client.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8').replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE IF NOT EXISTS'));
  const db={query:async(text:string,params?:any[])=>client.query(text,params)};
  const store=new HrStore(db);
  await client.query('INSERT INTO run_starts(id,user_id) VALUES(11,1),(12,2),(13,3),(14,4)');
  assert.equal(companyKey('  Example   LTD '),'example ltd');
  assert.equal(outreachKey('Example LTD','Data Analyst'),outreachKey('EXAMPLE LTD','Data   Analyst'));
  assert.deepEqual(await getHrOutreachSettings('1',db),{enabled:false});
  await setHrOutreachEnabled('1',true,db);await setHrOutreachEnabled('2',true,db);
  await assert.rejects(setHrOutreachEnabled('4',true,db),/administrators/);
  await assert.rejects(setHrOutreachEnabled('3',true,db),/administrators/);
  await client.query('INSERT INTO hr_outreach_preferences(user_id,enabled) VALUES(3,true),(4,true)');
  const enabledSince=(await client.query('SELECT enabled_since FROM hr_outreach_preferences WHERE user_id=1')).rows[0].enabled_since;
  await setHrOutreachEnabled('1',true,db);
  assert.equal(+(await client.query('SELECT enabled_since FROM hr_outreach_preferences WHERE user_id=1')).rows[0].enabled_since,+enabledSince,'idempotent enable cannot reset cutoff');
  await client.query(`INSERT INTO applications(id,user_id,job_id,platform,title,company,url,cover_letter,submitted_by_myasis,confirmation_status,outcome,applied_at) VALUES
    (1,1,'new','seek','Data Analyst','Example LTD','https://example.org/jobs/1','Approved evidence',true,NULL,NULL,now()+interval '1 second'),
    (2,1,'history','seek','Old Role','Example LTD','https://example.org/jobs/2',NULL,true,NULL,NULL,now()-interval '1 day'),
    (3,1,'uncertain','seek','Other Role','Example LTD','https://example.org/jobs/3',NULL,false,'unconfirmed',NULL,now()+interval '1 second'),
    (4,1,'draft','seek','Draft','Example LTD','https://example.org/jobs/4',NULL,false,NULL,NULL,now()+interval '1 second'),
    (5,2,'peer','seek','Data Analyst','Example LTD','https://example.org/jobs/1',NULL,true,NULL,NULL,now()+interval '1 second'),
    (6,3,'blocked','seek','Blocked Role','Example LTD','https://example.org/jobs/6',NULL,true,NULL,NULL,now()+interval '1 second'),
    (7,1,'duplicate','indeed','Data Analyst','EXAMPLE LTD','https://example.org/jobs/1',NULL,true,NULL,NULL,now()+interval '1 second'),
    (8,4,'ordinary','seek','Ordinary Role','Example LTD','https://example.org/jobs/8',NULL,true,NULL,NULL,now()+interval '1 second');`);
  await client.query('UPDATE applications SET source_run_id=user_id+10 WHERE id<>2');
  await store.enqueue();assert.equal((await listHrOutreach('1',db)).length,0,'an active run never queues HR outreach');
  assert.equal((await hrOutreachProgress('1',db)).phase,'waiting');
  await client.query('UPDATE run_starts SET finished_at=now()');
  await store.enqueue();assert.equal((await listHrOutreach('1',db)).length,0,'a child exiting is insufficient until complete result-saving and cleanup');
  await client.query('UPDATE run_starts SET hr_ready_at=now()');
  await store.enqueue();await store.enqueue();
  assert.equal((await listHrOutreach('1',db)).length,2,'original and explicitly skipped duplicate only');
  assert.equal((await listHrOutreach('2',db)).length,1,'other owner has independent outreach');
  assert.equal((await listHrOutreach('3',db)).length,0,'blocked account excluded');
  assert.equal((await listHrOutreach('4',db)).length,0,'ordinary account with saved opt-in cannot enqueue');
  assert.equal((await listHrOutreach('1',db)).filter(r=>r.status==='skipped').length,1);
  const job=await store.claim();assert.ok(job);assert.equal(job.user_id,'1');
  assert.ok(await store.allowed(job));
  await client.query('UPDATE run_starts SET hr_ready_at=NULL WHERE id=11');assert.equal(await store.allowed(job),false);assert.equal(await store.sending(job),false,'not-ready run cannot send even with a retained claim');await client.query('UPDATE run_starts SET hr_ready_at=now() WHERE id=11');
  for(const phase of ['researching','writing','sending','checking'] as const){await store.setPhase(job,phase);const progress=await hrOutreachProgress('1',db);assert.equal(progress.active,true);assert.equal(progress.phase,phase);assert.equal(progress.runId,'11');assert.equal(progress.title,'Data Analyst');}
  assert.equal((await hrOutreachProgress('2',db)).active,false,'progress never crosses accounts');
  process.env.ADMIN_EMAILS='admin-two@example.test';assert.equal(await store.allowed(job),false,'admin revocation blocks pending job');assert.equal(await store.sending(job),false,'final send claim rechecks role');process.env.ADMIN_EMAILS='admin-one@example.test,admin-two@example.test';
  assert.equal((await store.claim())?.user_id,'2','concurrent claim cannot reuse researching job');
  await client.query(`INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,status,lease,lease_until)
    VALUES(4,8,'fixture','forged-ordinary','ordinary','seek','Ordinary Role','Example LTD','https://example.org/jobs/8','researching','forged-lease',now()+interval '10 minutes')`);
  const forged=(await client.query('SELECT *,id::text,user_id::text,application_id::text FROM hr_outreach WHERE user_id=4')).rows[0];
  assert.equal(await store.allowed(forged),false,'ordinary users cannot process forged or legacy queue records');assert.equal(await store.sending(forged),false,'ordinary users cannot claim final send');
  await client.query("UPDATE hr_outreach SET status='queued',lease=NULL WHERE user_id=4");assert.equal(await store.claim(),null,'ordinary records remain excluded from worker claims');
  const contact:HiringContact={email:'careers@example.org',kind:'recruitment',companyDomain:'example.org',sourceUrl:'https://example.org/careers',sourceText:'Recruitment',validatedAt:new Date().toISOString()};
  await store.saveContact(job.company_key,job.company,contact,'Published');
  assert.equal((await store.cache(job.company_key))?.fresh,true);
  const ttl=(await client.query("SELECT extract(epoch FROM (next_validation_at-validated_at))/86400 AS days FROM hr_company_contacts")).rows[0].days;
  assert.ok(Number(ttl)>=28&&Number(ttl)<=31,'calendar-month validation TTL');
  await client.query("UPDATE hr_company_contacts SET next_validation_at=now()-interval '1 second'");
  assert.equal((await store.cache(job.company_key))?.fresh,false);
  assert.equal((await store.staleContact())?.contact.email,contact.email,'monthly worker sees stale contact');
  await client.query("UPDATE hr_company_contacts SET validated_at=now()-interval '2 months'");await store.deferValidation(job.company_key);
  assert.equal((await store.cache(job.company_key))?.fresh,false,'retry schedule cannot renew expired publication validity');
  await store.saveContact('negative','Absent Company',null,'No published contact');
  const negativeTtl=(await client.query("SELECT extract(epoch FROM (next_validation_at-validated_at))/86400 AS days FROM hr_company_contacts WHERE company_key='negative'")).rows[0].days;
  assert.equal(Number(negativeTtl),1,'negative contact cache only lasts one day');
  await store.draft(job,contact,'Application follow-up','Exact message',0.01);
  assert.ok(await store.sending(job));assert.equal(await store.sending(job),false,'send transition occurs once');
  await client.query("UPDATE hr_outreach SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  await store.recover();
  const recovered=(await listHrOutreach('1',db)).find(r=>r.id===job.id)!;
  assert.equal(recovered.status,'unconfirmed','crash after send never requeues a new send');
  const uncertain=await store.claim();assert.equal(uncertain?.status,'unconfirmed');assert.ok(uncertain);
  await store.defer(uncertain);assert.equal((await listHrOutreach('1',db)).find(r=>r.id===job.id)?.status,'unconfirmed','resource contention never makes uncertain sends sendable');
  await client.query("UPDATE hr_outreach SET available_at=now() WHERE id=$1",[job.id]);
  const reconcile=await store.claim();assert.ok(reconcile);await store.finish(reconcile,'sent',null,{messageId:'fixture-receipt'});
  assert.equal((await listHrOutreach('1',db)).find(r=>r.id===job.id)?.body,'Exact message');
  const completed=await hrOutreachProgress('1',db);assert.equal(completed.active,false);assert.equal(completed.phase,'finished');assert.equal(completed.sent,1);assert.equal(completed.skipped,1);
  const page=await listHrOutreachPage('1',{},db);assert.equal(page.items.length,2);assert.equal(page.nextCursor,null);
  assert.equal((await listHrOutreachPage('1',{jobId:'new',platform:'seek'},db)).items.length,1);
  await assert.rejects(listHrOutreachPage('1',{cursor:'1;select secret'},db),/Invalid/);
  await client.query(`INSERT INTO applications(id,user_id,job_id,platform,title,company,url,submitted_by_myasis,applied_at)
    SELECT n,1,n::text,'seek','Historical role '||n,'Fixture Company','https://example.org/jobs/'||n,true,now() FROM generate_series(100,154) n;
    INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,status,body)
    SELECT 1,n,'fixture','fixture-'||n,n::text,'seek','Historical role '||n,'Fixture Company','https://example.org/jobs/'||n,'sent','Historical exact email '||n FROM generate_series(100,154) n;`);
  const first=await listHrOutreachPage('1',{},db);assert.equal(first.items.length,50);assert.ok(first.nextCursor);
  const second=await listHrOutreachPage('1',{cursor:first.nextCursor},db);assert.equal(second.items.length,7);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,57,'real SQL pages neither overlap nor lose old messages');
  assert.equal((await listHrOutreachPage('1',{jobId:'100',platform:'seek'},db)).items[0].body,'Historical exact email 100');
  const platformContact={...contact,email:'hello@freehire.me',companyDomain:'freehire.me',sourceUrl:'https://freehire.me/talent',sourceText:'Hiring? Request access Join the network'};
  const financeContact={...contact,email:'josh@lansonpartners.com',companyDomain:'lansonpartners.com',sourceUrl:'https://www.lansonpartners.com/our-team',sourceText:'Josh Fordham recruits for the Treasury & Finance market.'};
  await client.query(`UPDATE hr_outreach SET contact=$1,to_email=$2,message_id='original-receipt',company='FiftyFive Group Pty Ltd' WHERE job_id='100'`,[JSON.stringify(platformContact),platformContact.email]);
  await client.query(`UPDATE hr_outreach SET contact=$1,to_email=$2,company='Lanson Partners',title='Senior Software Engineer AI Enablement' WHERE job_id='101'`,[JSON.stringify(financeContact),financeContact.email]);
  await store.saveContact('bad-platform','MKA IT Services',platformContact,'Legacy platform contact');
  await client.query("UPDATE hr_company_contacts SET contact_assessed_version=0 WHERE company_key='bad-platform'");
  await store.auditContacts();await store.auditContacts();
  const audited=await listHrOutreachPage('1',{jobId:'100',platform:'seek'},db),specialist=await listHrOutreachPage('1',{jobId:'101',platform:'seek'},db);
  assert.equal(audited.items[0].status,'sent','quality audit never erases a genuine send');
  assert.equal(audited.items[0].toEmail,'hello@freehire.me');assert.equal(audited.items[0].body,'Historical exact email 100');
  assert.equal(audited.items[0].contactReviewRequired,true);assert.match(audited.items[0].contactReviewReason,/platform/);
  assert.equal(specialist.items[0].contactReviewRequired,true);assert.match(specialist.items[0].contactReviewReason,/finance/);
  assert.equal((await client.query("SELECT message_id FROM hr_outreach WHERE job_id='100'")).rows[0].message_id,'original-receipt');
  assert.equal(await store.cache('bad-platform'),null,'invalid platform contact cannot be reused');
  await client.query(`INSERT INTO applications(id,user_id,job_id,platform,title,company,url,submitted_by_myasis,applied_at,source_run_id)
    SELECT n,1,n::text,'seek','Retry fixture '||n,'Fixture Company','https://example.org/jobs/'||n,true,now(),11 FROM generate_series(210,212) n;
    INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,status,attempts,retry_allowed)
    SELECT 1,n,'fixture','retry-'||n,n::text,'seek','Retry fixture '||n,'Fixture Company','https://example.org/jobs/'||n,'error',CASE WHEN n=210 THEN 4 ELSE 1 END,n<>211 FROM generate_series(210,212) n;`);
  const retry=await store.claim();assert.ok(retry);assert.equal(retry.job_id,'212','only a retryable non-exhausted error can be reclaimed');
  await store.recordLookup(retry,{contact:null,reason:'Provider temporarily unavailable.',outcome:'temporarily_unavailable',retryable:true,pagesRead:0,
    diagnostics:{stage:'public_sources',searches:1,pagesAttempted:0,pagesRead:0,pagesBlocked:0,pagesFailed:0,candidatesRejected:0,unresolvedPriorityPages:0,events:[]}});
  await store.recordFailure(retry,'researching','unexpected_error');
  await store.finish(retry,'error','The public search provider is temporarily unavailable.',undefined,0,{retryable:true});
  const pending=(await listHrOutreachPage('1',{jobId:'212',platform:'seek'},db)).items[0];
  assert.ok(pending.lookupCheckedAt);assert.ok(pending.lookupRetryAt);assert.equal(pending.lookupOutcome,'temporarily_unavailable');
  assert.equal('lookup_diagnostics' in pending,false,'internal traces never appear in customer history');
  await client.query('UPDATE hr_outreach_preferences SET enabled=false WHERE user_id=1');
  assert.equal((await listHrOutreachPage('1',{jobId:'212',platform:'seek'},db)).items[0].lookupRetryAt,null,'opt-out cannot advertise a scheduled retry');
  await client.query('UPDATE hr_outreach_preferences SET enabled=true WHERE user_id=1');
  await client.query('UPDATE run_starts SET hr_ready_at=NULL WHERE id=11');
  assert.equal((await listHrOutreachPage('1',{jobId:'212',platform:'seek'},db)).items[0].lookupRetryAt,null,'a run not ready for HR cannot advertise a retry');
  await client.query('UPDATE run_starts SET hr_ready_at=now() WHERE id=11');
  await client.query("UPDATE applications SET outcome='closed' WHERE id=212");
  assert.equal((await listHrOutreachPage('1',{jobId:'212',platform:'seek'},db)).items[0].lookupRetryAt,null,'an invalidated application cannot advertise a retry');
  await client.query('UPDATE applications SET outcome=NULL WHERE id=212');
  assert.equal((await listHrOutreachPage('1',{jobId:'210',platform:'seek'},db)).items[0].lookupRetryAt,null,'no false retry date after the final attempt');
  assert.equal((await listHrOutreachPage('1',{jobId:'211',platform:'seek'},db)).items[0].lookupRetryAt,null,'permanent failure does not advertise a retry');
  await client.query("UPDATE hr_outreach SET available_at=now(),attempts=4 WHERE job_id='212'");
  assert.equal(await store.claim(),null,'exhausted or permanent errors cannot restart');
  await client.query("UPDATE hr_outreach SET status='researching',phase='writing',lease='crashed-fourth-attempt',lease_until=now()-interval '1 minute' WHERE job_id='212'");
  await client.query("UPDATE hr_outreach SET status='queued' WHERE job_id='210'");
  await store.recover();
  for(const id of ['210','212']){const recovered=(await listHrOutreachPage('1',{jobId:id,platform:'seek'},db)).items[0];
    assert.equal(recovered.status,'error','an exhausted pre-send crash must not remain queued forever');
    assert.match(recovered.reason,/Automatic retries have finished/);assert.equal(recovered.lookupRetryAt,null);}
  const observedAt=new Date(Date.now()-14*86400_000).toISOString();
  const storedContact={...contact,sourceKind:'stored_vacancy' as const,validatedAt:observedAt};
  await store.saveContact('stored-source','Example LTD',storedContact,'Published in the saved advertisement');
  const stored=(await client.query("SELECT validated_at,next_validation_at FROM hr_company_contacts WHERE company_key='stored-source'")).rows[0];
  assert.equal(stored.validated_at.toISOString(),observedAt,'a lookup cannot freshen the original stored-source observation');
  assert.ok(stored.next_validation_at.getTime()<Date.now()+18*86400_000,'the monthly source TTL starts when evidence was observed');
  await store.saveContact('negative-context','Example LTD',null,'No contact',undefined,'specific-vacancy');
  assert.equal((await store.cache('negative-context'))?.contextKey,'specific-vacancy');
  await assert.rejects(store.saveContact('invalid-date','Example LTD',{...contact,validatedAt:'invalid'},'Invalid'),/valid check date/);
  await setHrOutreachEnabled('2',false,db);
  assert.equal((await listHrOutreach('2',db))[0].status,'skipped','opt-out cancels unsent work');
  await client.query('DELETE FROM users WHERE id=1');
  assert.equal((await listHrOutreach('1',db)).length,0,'private messages cascade on deletion');
  assert.ok(await store.cache(job.company_key),'shared public contact survives account deletion');
  console.log('PASS: real PostgreSQL HR queue, opt-in, no historical/draft sends, duplicate prevention, owner isolation, monthly cache TTL, leases, uncertain recovery and deletion. TEMP tables only.');
}finally{await client.query('ROLLBACK');client.release();await getPool().end();if(oldAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldAdmins;}
