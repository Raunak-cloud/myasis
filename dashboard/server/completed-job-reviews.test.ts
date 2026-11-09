import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after,test } from 'node:test';
import { getPool } from './db/index.js';
import { exportCompletedJobReviews,syncCompletedJobReviews } from './completed-job-reviews.js';
import { COMPLETED_REVIEWS_FILE,readCompletedReviews } from '../../seek-bot/src/completed-reviews.js';

after(async()=>{await getPool().end();});

test('completed reviews backfill, survive export/replay and crashes, and never cross account boundaries',async()=>{
 const pool=getPool(),client=await pool.connect(),original=pool.query;
 const schema=`completed_reviews_${randomUUID().replaceAll('-','')}`;
 const directory=mkdtempSync(join(tmpdir(),'owtomate-review-db-'));
 const source=readFileSync(new URL('./db/schema.sql',import.meta.url),'utf8');
 const migration=source.slice(source.indexOf('-- BEGIN completed job reviews'),source.indexOf('-- END completed job reviews'));
 const row=(id:string,decision='apply')=>({key:`listing:seek:${id}`,keys:[`listing:seek:${id}`],jobId:id,platform:'seek',title:'Analyst',company:'Fixture',reviewedAt:'2026-01-01T00:00:00Z',
   assessment:{decision,shouldApply:decision==='apply',matchScore:85,reason:'Existing decision',evidence:['Fixture'],injectionSuspected:false}});
 try{
  await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);
  await client.query(`CREATE TABLE users(id BIGINT PRIMARY KEY);INSERT INTO users VALUES(1),(2);
   CREATE TABLE job_review_decisions(user_id BIGINT,job_id TEXT,listing_fingerprint TEXT,context_fingerprint TEXT,
    content_fingerprint TEXT,disposition TEXT,title TEXT,company TEXT,reason TEXT,reviewed_at TIMESTAMPTZ);
   CREATE TABLE run_events(user_id BIGINT,job_id TEXT,url TEXT,review_listing_fingerprint TEXT,ts TIMESTAMPTZ);
   CREATE TABLE application_reviews(user_id BIGINT,payload JSONB,updated_at TIMESTAMPTZ);
   INSERT INTO job_review_decisions VALUES(1,'old-negative','fingerprint','context',null,'fit-mismatch','Analyst','Fixture','Salary below minimum','2026-01-01');
   INSERT INTO run_events VALUES(1,'old-negative','https://www.seek.com.au/job/old-negative','fingerprint','2026-01-01');`);
  await client.query('INSERT INTO application_reviews VALUES(1,$1,now())',[JSON.stringify({job:{id:'old-positive',platform:'indeed',title:'Analyst',company:'Fixture',fitReview:{score:90,reason:'Approved fit',evidence:['Prior evidence']}}})]);
  await client.query(migration);
  pool.query=client.query.bind(client) as typeof original;
  writeFileSync(join(directory,COMPLETED_REVIEWS_FILE),[row('fresh'),row('rejected','skip')].map(x=>JSON.stringify(x)).join('\n'));
  await syncCompletedJobReviews('1',directory);
  await client.query('INSERT INTO completed_job_reviews VALUES(2,$1,$2,now())',[row('fresh','skip').key,JSON.stringify(row('fresh','skip'))]);
  await exportCompletedJobReviews('1',directory);
  let saved=readCompletedReviews(join(directory,COMPLETED_REVIEWS_FILE));
  assert.equal(saved.length,4);assert.equal(saved.find(x=>x.jobId==='fresh')?.assessment.decision,'apply');
  assert.equal(saved.find(x=>x.jobId==='old-negative')?.assessment.decision,'skip');
  assert.equal(saved.find(x=>x.jobId==='old-positive')?.assessment.matchScore,90);
  // An older run replays a different decision. The first completed owner review remains authoritative.
  writeFileSync(join(directory,COMPLETED_REVIEWS_FILE),JSON.stringify(row('fresh','skip'))+'\n'+JSON.stringify(row('crash-recovered'))+'\n{truncated');
  await exportCompletedJobReviews('1',directory);
  saved=readCompletedReviews(join(directory,COMPLETED_REVIEWS_FILE));
  assert.equal(saved.length,5);assert.equal(saved.find(x=>x.jobId==='fresh')?.assessment.decision,'apply');
  writeFileSync(join(directory,COMPLETED_REVIEWS_FILE),Array.from({length:501},(_,i)=>JSON.stringify(row('batch-'+i))).join('\n'));
  await exportCompletedJobReviews('1',directory);
  assert.equal(readCompletedReviews(join(directory,COMPLETED_REVIEWS_FILE)).length,506,'history survives multiple import batches and the visible 500-row retention');
  await client.query(migration);
  assert.equal((await client.query('SELECT count(*)::int n FROM completed_job_reviews WHERE user_id=1')).rows[0].n,506);
  await client.query('DELETE FROM users WHERE id=1');
  assert.equal((await client.query('SELECT count(*)::int n FROM completed_job_reviews WHERE user_id=1')).rows[0].n,0);
  assert.equal((await client.query('SELECT payload FROM completed_job_reviews WHERE user_id=2')).rows[0].payload.assessment.decision,'skip');
 }finally{
  pool.query=original;await client.query('ROLLBACK');await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'owtomate-review-db-'));rmSync(directory,{recursive:true,force:true});
 }
});
