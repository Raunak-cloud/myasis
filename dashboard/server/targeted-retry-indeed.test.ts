import assert from 'node:assert/strict';
import test from 'node:test';
import {targetedIndeedRetryJobs} from './targeted-retry-indeed.js';
const id='abc123def4567890',other='1111111111111111';
const row={job_id:id,title:'Analyst',company:'Fixture',url:`https://au.indeed.com/viewjob?jk=${id}`};
test('exact Indeed retry metadata comes from the requested owner and original posting',async()=>{
 let reads=0;
 const read=async(sql:string,args:unknown[])=>{reads++;assert.match(sql,/WHERE user_id=\$1 AND job_id=ANY/);assert.deepEqual(args,['183',[id]]);return [row];};
 assert.deepEqual(await targetedIndeedRetryJobs('183',[id],read as never),[{job_id:id,title:'Analyst',company:'Fixture'}]);assert.equal(reads,1);
});
test('unknown owners, unrecorded IDs and a different board/posting cannot become a targeted retry',async()=>{
 const absent=async()=>[];
 assert.equal(await targetedIndeedRetryJobs('183',[id],absent as never),null);
 assert.equal(await targetedIndeedRetryJobs('bad',[id],(()=>{throw Error('must not query');}) as never),null);
 assert.equal(await targetedIndeedRetryJobs('183',['123'],absent as never),null);
 for(const url of [`https://au.indeed.com/viewjob?jk=${other}`,`https://www.seek.com.au/job/12345678`,`https://au.indeed.com.evil.invalid/viewjob?jk=${id}`,`https://secret@au.indeed.com/viewjob?jk=${id}`,`http://au.indeed.com/viewjob?jk=${id}`]){
  assert.equal(await targetedIndeedRetryJobs('183',[id],(async()=>[{...row,url}]) as never),null,url);
 }
 assert.equal(await targetedIndeedRetryJobs('183',[id,other],(async()=>[row]) as never),null,'all requested records must exist');
});
