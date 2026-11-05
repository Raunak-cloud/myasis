import assert from 'node:assert/strict';
import {before,beforeEach,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readEnv} from '../runner.js';
import {JobIndexStore} from './store.js';
import {paidProfiles} from './accounts.js';
import {normaliseJob,matchJob} from './extract.js';
import {crawlCycle,discoveredFeed} from './engine.js';
import {PublicCrawler,CrawlDeferred} from './network.js';
import {confirmedMatch,type FitReviewer} from './review.js';
import type {SearchProfile} from './types.js';
import {discoveryQueries} from './discovery.js';
const schema=`job_index_test_${randomUUID().replaceAll('-','')}`;
const connectionString=process.env.JOB_INDEX_TEST_URL??process.env.DATABASE_URL??readEnv().DATABASE_URL;
if(!connectionString)throw Error('A local PostgreSQL test connection is required.');
const pool=new pg.Pool({connectionString,max:4,options:`-c search_path=${schema}`}),store=new JobIndexStore(pool);
const profile:SearchProfile={userId:'1',fingerprint:'one',keywords:['Data engineer'],skills:['Python','SQL'],location:'Sydney',arrangements:['remote'],excludedCompanies:[],sources:{}};
const facts={resume:'Data engineer using Python and SQL.',instructions:''};
const job=normaliseJob({title:'Data engineer',hiringOrganization:{name:'Fictional publisher'},description:'Use Python and SQL to build reliable data engineering systems. Fully remote work.'},'https://careers.fixture.org/jobs/123')!;
const pass:FitReviewer=async j=>({decision:'match',score:90,reason:'Relevant engineering duties and evidence.',employerEvidence:j.description.slice(0,40),candidateEvidence:'Data engineer',constraints:'satisfied'});
const approval=async(p=profile,j=job)=>({profile:p,match:confirmedMatch(await pass(j,p,facts),j,p,facts,matchJob(j,p)!)!});
before(async()=>{await pool.query(`CREATE SCHEMA ${schema}`);await store.migrate();await pool.query(`
 CREATE TABLE users(id bigint PRIMARY KEY,blocked_at timestamptz);
 CREATE TABLE application_credit_grants(user_id bigint,purchase_id bigint,expires_at timestamptz);
 CREATE TABLE billing_purchases(id bigint,user_id bigint,plan_key text);
 CREATE TABLE profiles(user_id bigint,skills text,headline text);
 CREATE TABLE settings(user_id bigint,key text,value text);
 CREATE TABLE resumes(id bigint,user_id bigint,file_name text,is_default boolean,uploaded_at timestamptz);
 CREATE TABLE applications(user_id bigint,url text,external boolean,applied_at timestamptz);`);});
beforeEach(async()=>{await pool.query(`TRUNCATE search_profiles,indexed_jobs,job_versions,candidate_job_matches,fit_decisions,fit_review_requests,crawl_tasks,crawl_cycles,search_usage,users,application_credit_grants,billing_purchases,profiles,settings,resumes,applications CASCADE;
 UPDATE job_index_config SET enabled=true;
 INSERT INTO users VALUES(1,NULL),(2,NULL),(3,now());
 INSERT INTO billing_purchases VALUES(1,1,'essential-pass'),(2,2,'intensive-pass'),(3,3,'job-search-pass');
 INSERT INTO application_credit_grants VALUES(1,1,now()+interval '1 day'),(2,2,now()-interval '1 day'),(3,3,now()+interval '1 day');
 INSERT INTO settings VALUES(1,'KEYWORDS','Data engineer'),(1,'WORK_ARRANGEMENTS','remote'),(2,'KEYWORDS','Never read this owner');
 INSERT INTO profiles VALUES(1,'Python, SQL','Data engineer');`);});
after(async()=>{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();});

test('only current AI-approved owners can atomically retain jobs and content versions',async()=>{
 await store.migrate();assert.equal(await store.save(job,[]),false);
 const a=await approval();await assert.rejects(()=>store.save(job,[{...a,match:{...a.match,status:'potential'} as any}]));
 assert.equal(await store.save(job,[a]),false,'missing owner cannot admit a job');
 await store.profiles([profile]);await Promise.all([store.save(job,[a]),store.save(job,[a])]);
 assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'1');
 assert.equal((await pool.query('SELECT count(*) FROM job_versions')).rows[0].count,'1');
 const shown=(await store.search(new URLSearchParams({user:'1'})) as any).jobs;assert.equal(shown.length,1);assert.equal(shown[0].matches[0].userId,'1');assert.equal(shown[0].matches[0].match.review.score,90);assert.ok(shown[0].first_seen_at);assert.ok(shown[0].payload_hash);
 assert.equal((await store.search(new URLSearchParams({user:'2'})) as any).jobs.length,0);
 await store.profiles([{...profile,fingerprint:'changed'}]);
 assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM job_versions')).rows[0].count,'0');
 assert.equal(await store.save(job,[a]),false,'stale review cannot restore a removed match');
});

test('paused cycles still remove stale owners and jobs beyond their saved age limit',async()=>{
 const p={...profile,criteria:{minScore:60,minSalary:0,minHourlyRate:0,maxAgeDays:1,jobTypes:[]}};
 const recent={...job,postedAt:new Date().toISOString()};await store.profiles([p]);await store.save(recent,[await approval(p,recent)]);
 await pool.query("UPDATE indexed_jobs SET posted_at=now()-interval '3 days'");await store.profiles([p]);assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'0');
 await store.setEnabled('99',false);await pool.query('UPDATE users SET blocked_at=now() WHERE id=1');
 const stats=await crawlCycle(store,pool,{reviewer:async()=>{throw Error('Paused crawler must not review');}});assert.equal(stats.status,'paused');assert.equal((await pool.query('SELECT count(*) FROM search_profiles')).rows[0].count,'0');
});

test('legacy unreviewed catalog entries are removed by an idempotent catalog-only migration',async()=>{
 await pool.query('UPDATE job_index_config SET match_policy=NULL');await store.enqueue('page',{url:job.url});const task=(await store.claim())!;await store.finish(task,'done');
 await pool.query(`INSERT INTO indexed_jobs(id,canonical_url,title,company,description,source,source_id,payload,payload_hash,arrangement,pay_status) VALUES($1,$2,'Legacy','Fixture','Old public listing','fixture','x',$3,'legacy','not-mentioned','not-mentioned')`,[job.id,job.url,JSON.stringify(job)]);
 await store.migrate();const due=(await pool.query('SELECT due_at FROM crawl_tasks')).rows[0].due_at;assert.ok(+due<=Date.now());await store.migrate();assert.equal(+(await pool.query('SELECT due_at FROM crawl_tasks')).rows[0].due_at,+due);assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM application_credit_grants')).rows[0].count,'3');
});

test('negative review cache stores hashes only; requests and leases enforce shared budgets and ownership',async()=>{
 await store.profiles([profile]);await store.cacheDecision(profile,job,null);
 assert.equal(await store.cachedDecision(profile,job),null);assert.equal(await store.cachedDecision({...profile,fingerprint:'new'},job),undefined);
 assert.doesNotMatch(JSON.stringify((await pool.query('SELECT * FROM fit_decisions')).rows),/Fictional publisher|data engineering systems|using Python and SQL/);
 const reservations=await Promise.all(Array.from({length:105},()=>store.reserveReview(0.001)));assert.equal(reservations.filter(Boolean).length,100);
 await store.enqueue('feed',{source:'greenhouse',target:'Fixture',job:{id:'one',url:job.url,title:'Do not persist this',description:'Rejected job body'}},3);
 assert.doesNotMatch(JSON.stringify((await pool.query('SELECT payload FROM crawl_tasks')).rows),/Do not persist|Rejected job body/);
 const claims=await Promise.all([store.claim({kind:'feed',source:'greenhouse'}),store.claim({kind:'feed',source:'greenhouse'})]);assert.equal(claims.filter(Boolean).length,1);
 const old=claims.find(Boolean)!;await pool.query("UPDATE crawl_tasks SET lease_until=now()-interval '1 second' WHERE key=$1",[old.key]);const current=(await store.claim())!;
 await store.finish(old,'done');assert.equal((await pool.query('SELECT state FROM crawl_tasks')).rows[0].state,'running');await store.finish(current,'done');
});

test('only active paid evidence is read, redacted and cached; changed criteria invalidate it',async()=>{
 await pool.query("INSERT INTO resumes VALUES(1,1,'fictional.txt',true,now())");let reads=0;
 const read=async(user:string)=>{assert.equal(user,'1');reads++;return 'Data engineer using Python and SQL. person@example.test 0400000000';};
 const first=await paidProfiles(pool,read);assert.deepEqual(first.profiles.map(p=>p.userId),['1']);assert.equal(reads,1);
 assert.doesNotMatch(first.evidence.get('1')!.resume,/person@|0400000000/);assert.doesNotMatch(JSON.stringify(first.profiles),/person@|0400000000|fictional/);
 await paidProfiles(pool,read,first.profiles);assert.equal(reads,1);
 await pool.query("INSERT INTO settings VALUES(1,'MIN_SCORE','85')");const next=await paidProfiles(pool,read,first.profiles);assert.notEqual(next.profiles[0].fingerprint,first.profiles[0].fingerprint);assert.equal(next.profiles[0].criteria?.minScore,85);
});

function crawlerFor(jobs:any[]){return new PublicCrawler(async address=>({url:address,status:200,type:'text/html',retryAfter:null,text:address.endsWith('/robots.txt')?'User-agent: *\nAllow: /':`<script type="application/ld+json">${JSON.stringify(jobs)}</script>`}));}
const raw=(title:string,url:string)=>({'@type':'JobPosting',title,hiringOrganization:{name:'Fictional publisher'},description:job.description,url});
test('full discovery admits matching jobs only; uncertainty and failures never become matches',async()=>{
 const url=job.url;await store.enqueue('page',{url,depth:0});let reviews=0;
 const reviewer:FitReviewer=async(j,p,e)=>{reviews++;return {...await pass(j,p,e),decision:j.title==='Uncertain engineer'?'uncertain':j.title==='Retail assistant'?'no_match':'match'};};
 const stats=await crawlCycle(store,pool,{maxTasks:1,reviewer,crawler:crawlerFor([raw('Data engineer',url),raw('Retail assistant',url+'-no'),raw('Uncertain engineer',url+'-uncertain')])});
 assert.equal(stats.jobsSaved,1);assert.equal(reviews,3);assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'1');
 assert.equal((await pool.query('SELECT count(*) FROM candidate_job_matches')).rows[0].count,'1');
 await pool.query('DELETE FROM crawl_tasks');await store.enqueue('page',{url:url+'-failure'});
 const failed=await crawlCycle(store,pool,{maxTasks:1,reviewer:async()=>{throw new CrawlDeferred(1000);},crawler:crawlerFor([raw('Data engineer',url+'-failure')])});assert.equal(failed.deferred,1);
 assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM applications')).rows[0].count,'0');
});

test('expanded search combines role and resume skills while returned provider URLs stay transient',async()=>{
 const profiles=(await paidProfiles(pool)).profiles,query=discoveryQueries(profiles)[1];assert.match(query,/Python|SQL/);assert.match(query,/Data engineer/);
 await store.enqueue('search',{query},100);let searches=0;
 const stats=await crawlCycle(store,pool,{maxTasks:1,reviewer:pass,braveKey:'fictional',crawler:crawlerFor([raw('Data engineer',job.url)]),searchFetch:async(_url,init)=>{searches++;assert.match(String(_url),/freshness=pm/);assert.doesNotMatch(String(_url),/person@|resume/);assert.match(String(init?.headers&&JSON.stringify(init.headers)),/fictional/);return Response.json({web:{results:[{url:'https://careers.fixture.org/transient-lead',description:'Do not store snippet'}]}});}});
 assert.equal(searches,1);assert.equal(stats.jobsSaved,1);assert.doesNotMatch(JSON.stringify((await pool.query('SELECT payload FROM crawl_tasks')).rows),/transient-lead|Do not store snippet/);
 assert.deepEqual(discoveredFeed('https://job-boards.greenhouse.io/Fixture/jobs/123'),{source:'greenhouse',target:'Fixture'});
});

test('one uncertain owner cannot prevent a confirmed match for another paid owner',async()=>{
 await pool.query("UPDATE application_credit_grants SET expires_at=now()+interval '1 day' WHERE user_id=2; UPDATE settings SET value='Data engineer' WHERE user_id=2; INSERT INTO profiles VALUES(2,'Python, SQL','Data engineer')");
 await store.enqueue('page',{url:job.url});
 const stats=await crawlCycle(store,pool,{maxTasks:1,crawler:crawlerFor([raw('Data engineer',job.url)]),reviewer:async(j,p,e)=>({...await pass(j,p,e),decision:p.userId==='1'?'uncertain':'match'})});
 assert.equal(stats.jobsSaved,1);assert.equal(stats.deferred,1);assert.deepEqual((await pool.query('SELECT user_id::text FROM candidate_job_matches')).rows,[{user_id:'2'}]);
 const p=(await store.cachedProfiles()).find(p=>p.userId==='1')!;assert.equal(await store.cachedDecision(p,job),'uncertain');
});

test('uncertain vacancies do not block independently observed employer discovery',async()=>{
 const url='https://example.wd3.myworkdayjobs.com/en-US/External/job/Sydney/Analyst';await store.enqueue('page',{url});
 const stats=await crawlCycle(store,pool,{maxTasks:1,crawler:crawlerFor([raw('Data engineer',url)]),reviewer:async(j,p,e)=>({...await pass(j,p,e),decision:'uncertain'})});
 assert.equal(stats.deferred,1);assert.equal(stats.jobsSaved,0);assert.equal((await pool.query('SELECT count(*) FROM indexed_jobs')).rows[0].count,'0');
 assert.equal((await pool.query("SELECT count(*) FROM crawl_tasks WHERE kind='feed' AND payload->>'source'='workday' AND payload->>'target'='https://example.wd3.myworkdayjobs.com/en-US/External'")).rows[0].count,'1');
});

test('scheduled crawls persist a six-hour start interval and do not rerun after restart',async()=>{
 const options={scheduled:true,maxTasks:0,reviewer:pass};
 const first=await crawlCycle(store,pool,options);assert.ok(Date.parse(String(first.nextCrawlAt))>Date.now()+5.99*3600_000);
 await pool.query("UPDATE crawl_cycles SET status='running'");
 const restartedStore=new JobIndexStore(pool);
 const waiting=await crawlCycle(restartedStore,pool,options);assert.equal(waiting.status,'waiting');assert.equal(waiting.nextCrawlAt,first.nextCrawlAt);assert.equal((await pool.query('SELECT status FROM crawl_cycles')).rows[0].status,'interrupted');
 assert.equal((await pool.query('SELECT count(*) FROM crawl_cycles')).rows[0].count,'1');
 await pool.query("UPDATE crawl_cycles SET started_at=now()-interval '6 hours 1 second'");
 const next=await crawlCycle(restartedStore,pool,options);assert.notEqual(next.status,'waiting');assert.equal((await pool.query('SELECT count(*) FROM crawl_cycles')).rows[0].count,'2');
});
