import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readEnv } from '../runner.js';
import { JobIndexStore } from './store.js';
import { paidProfiles } from './accounts.js';
import { normaliseJob } from './extract.js';
import { crawlCycle,discoveredFeed } from './engine.js';
import { PublicCrawler } from './network.js';

// Synthetic schema only; no production identity, resume, billing or application row is read.
const schema=`job_index_test_${randomUUID().replaceAll('-','')}`;
const connectionString=process.env.JOB_INDEX_TEST_URL??process.env.DATABASE_URL??readEnv().DATABASE_URL;
if(!connectionString)throw Error('A local PostgreSQL test connection is required.');
const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`});
const store=new JobIndexStore(pool);
after(async()=>{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();});

test('observed employer URLs discover feed identities without guessing a tenant',()=>{
  assert.deepEqual(discoveredFeed('https://job-boards.greenhouse.io/example/jobs/123'),{source:'greenhouse',target:'example'});
  assert.deepEqual(discoveredFeed('https://jobs.smartrecruiters.com/Example/123-role'),{source:'smartrecruiters',target:'Example'});
  assert.deepEqual(discoveredFeed('https://example.wd3.myworkdayjobs.com/en-US/External/job/Role'),{source:'workday',target:'https://example.wd3.myworkdayjobs.com/en-US/External'});
  assert.deepEqual(discoveredFeed('https://careers.pageuppeople.com/841/cw/en/job/123/role'),{source:'pageup',target:'https://careers.pageuppeople.com/841/cw/en'});
  assert.equal(discoveredFeed('https://public.org/job/unknown'),null);assert.equal(discoveredFeed('https://evil.org/boards.greenhouse.io/example'),null);
});

test('durable job indexing isolates private matches, snapshots, filters and concurrent leases',async()=>{
  await pool.query(`CREATE SCHEMA ${schema}`);await store.migrate();await store.migrate();
  const job=normaliseJob({title:'Data analyst',hiringOrganization:{name:'Fictional employer'},description:'Use Python and SQL to analyse data. This is a fully remote role.',jobLocationType:'TELECOMMUTE'},'https://careers.fixture.org/jobs/123')!;
  await Promise.all([store.save(job),store.save(job)]);assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM job_versions')).rows[0].count,'1');
  const p={userId:'1',fingerprint:'one',keywords:['Data analyst'],skills:['Python','SQL'],location:'Sydney',arrangements:['remote'],excludedCompanies:[],sources:{}};
  await store.profiles([p,{...p,userId:'2',fingerprint:'two',keywords:['Registered nurse'],skills:[]}]);assert.equal(await store.rematch([p]),1);
  assert.equal(await store.rematch([p]),0,'unchanged jobs and profiles do not need repeated match writes');
  const first=await store.search(new URLSearchParams({user:'1',arrangement:'remote',pay:'not-mentioned'})) as {jobs:unknown[]};assert.equal(first.jobs.length,1);
  assert.equal((await store.search(new URLSearchParams({user:'2'})) as {jobs:unknown[]}).jobs.length,0);
  assert.equal((await store.search(new URLSearchParams({q:'analyst'})) as {jobs:unknown[]}).jobs.length,1);
  assert.equal((await store.search(new URLSearchParams({q:"'; DROP TABLE indexed_jobs; --"})) as {jobs:unknown[]}).jobs.length,0);
  await store.save({...job,description:job.description+' Updated posting.'});assert.equal((await pool.query('SELECT count(*) FROM job_versions')).rows[0].count,'2');
  await store.enqueue('page',{url:job.url,depth:0});await store.enqueue('page',{url:job.url,depth:1});assert.equal((await pool.query('SELECT count(*) FROM crawl_tasks')).rows[0].count,'1');
  const claims=await Promise.all([store.claim(),store.claim()]);assert.equal(claims.filter(Boolean).length,1);const leased=claims.find(Boolean)!;
  await pool.query("UPDATE crawl_tasks SET lease_until=now()-interval '1 second' WHERE key=$1",[leased.key]);const reclaimed=(await store.claim())!;assert.notEqual(reclaimed.lease,leased.lease);
  await store.finish(leased,'done');assert.equal((await pool.query('SELECT state FROM crawl_tasks')).rows[0].state,'running','an obsolete worker must not finish a newly leased task');
  await store.finish(reclaimed,'failed','Controlled fixture failure');assert.equal((await pool.query('SELECT state FROM crawl_tasks')).rows[0].state,'queued');
  await store.setEnabled('99',false);assert.equal(await store.enabled(),false);assert.equal((await pool.query('SELECT actor_id::text,action FROM job_index_actions')).rows[0].actor_id,'99');
  const reservations=await Promise.all(Array.from({length:25},()=>store.reserveSearch()));assert.equal(reservations.filter(Boolean).length,20,'paid search calls have a durable daily limit');
  await store.close(job.url);assert.equal((await store.search(new URLSearchParams({user:'1'})) as {jobs:unknown[]}).jobs.length,0);
  await store.profiles([]);assert.equal((await pool.query('SELECT count(*) FROM candidate_job_matches')).rows[0].count,'0');
});

test('only active paid owners are read; resume skills are cached without storing private text',async()=>{
  await pool.query(`CREATE TABLE users(id bigint PRIMARY KEY,blocked_at timestamptz);
    CREATE TABLE application_credit_grants(user_id bigint,purchase_id bigint,expires_at timestamptz);
    CREATE TABLE billing_purchases(id bigint,user_id bigint,plan_key text);
    CREATE TABLE profiles(user_id bigint,skills text,headline text);
    CREATE TABLE settings(user_id bigint,key text,value text);
    CREATE TABLE resumes(id bigint,user_id bigint,file_name text,is_default boolean,uploaded_at timestamptz);
    CREATE TABLE applications(user_id bigint,url text,external boolean,applied_at timestamptz);
    INSERT INTO users VALUES(1,NULL),(2,NULL),(3,now()),(4,NULL);
    INSERT INTO billing_purchases VALUES(1,1,'essential-pass'),(2,2,'intensive-pass'),(3,3,'job-search-pass');
    INSERT INTO application_credit_grants VALUES(1,1,now()+interval '1 day'),(2,2,now()-interval '1 day'),(3,3,now()+interval '1 day');
    INSERT INTO settings VALUES(1,'KEYWORDS','Data analyst'),(2,'KEYWORDS','Never read this owner');
    INSERT INTO profiles VALUES(1,'Python, SQL','Analyst');
    INSERT INTO resumes VALUES(1,1,'fictional.txt',true,now());`);
  let reads=0;const read=async(user:string)=>{assert.equal(user,'1');reads++;return 'CONFIDENTIAL PERSON, secret@example.test, 0400000000. Data analyst using Python and SQL.';};
  const first=await paidProfiles(pool,read);assert.deepEqual(first.profiles.map(p=>p.userId),['1']);assert.equal(reads,1);assert.deepEqual(first.profiles[0].skills,['Python','SQL']);
  assert.doesNotMatch(JSON.stringify(first.profiles),/CONFIDENTIAL|secret@|0400000000|fictional\.txt/);
  await paidProfiles(pool,read,first.profiles);assert.equal(reads,1,'unchanged resumes must not be repeatedly parsed');
  await pool.query("UPDATE settings SET value='Data engineer' WHERE user_id=1");const second=await paidProfiles(pool,read,first.profiles);assert.equal(reads,2);assert.notEqual(first.profiles[0].fingerprint,second.profiles[0].fingerprint);
  await store.profiles(second.profiles);await pool.query('UPDATE users SET blocked_at=now() WHERE id=1');const revoked=await paidProfiles(pool,read);await store.profiles(revoked.profiles);assert.equal((await pool.query('SELECT count(*) FROM search_profiles')).rows[0].count,'0');
});

test('a complete synthetic crawl saves a tagged job and private match without application writes',async()=>{
  await store.setEnabled('99',true);await pool.query('UPDATE users SET blocked_at=NULL WHERE id=1');
  const url='https://careers.fixture.org/jobs/engine-test';await store.enqueue('page',{url,depth:0});
  const reads:string[]=[];const crawler=new PublicCrawler(async address=>{
    reads.push(address);return {url:address,status:200,type:'text/html',retryAfter:null,text:address.endsWith('/robots.txt')?'User-agent: *\nAllow: /':`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Data engineer',hiringOrganization:{name:'Fictional employer'},description:'A fully remote role using Python and SQL for reliable data engineering. Salary $90,000 per year.',url})}</script>`};
  });
  const stats=await crawlCycle(store,pool,{crawler,maxTasks:1});assert.equal(stats.jobsSaved,1);assert.equal(stats.failed,0);assert.deepEqual(reads,['https://careers.fixture.org/robots.txt',url]);
  const result=await store.search(new URLSearchParams({user:'1'})) as {jobs:Array<{payload:{pay:{status:string}}}>};assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].payload.pay.status,'disclosed');
  assert.equal((await pool.query('SELECT count(*) FROM applications')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM application_credit_grants')).rows[0].count,'3');
});
