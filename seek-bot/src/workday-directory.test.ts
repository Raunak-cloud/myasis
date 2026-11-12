import assert from 'node:assert/strict';import test from 'node:test';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {workdaySite,workdayDirectoryTargets} from './workday-directory.js';import {workdaySearchCache} from './workday-search-cache.js';import {EmployerFeedDiscovery} from './employer-feeds.js';
const root='https://fixture.wd105.myworkdayjobs.com/en-US/Careers';
test('public Workday discovery strips job paths and tracking; locales do not create duplicate employers',()=>{
 assert.equal(workdaySite(root+'/job/Sydney/Analyst_R123/apply?source=indeed'),root);
 assert.equal(workdaySite('https://bunnings.wd3.myworkdayjobs.com/Careers'), 'https://bunnings.wd3.myworkdayjobs.com/en-US/Careers');
 assert.equal(workdaySite('https://bunnings.wd3.myworkdayjobs.com/Careers/job/Sydney/Analyst_R1'), 'https://bunnings.wd3.myworkdayjobs.com/en-US/Careers');
 assert.equal(workdayDirectoryTargets(['Fixture|'+root,root.replace('en-US','en-GB')]).length,1);
 for(const u of ['https://private.invalid/en-US/Careers','http://fixture.wd1.myworkdayjobs.com/en-US/Careers','https://x:y@fixture.wd1.myworkdayjobs.com/en-US/Careers','https://fixture.wd1.myworkdayjobs.com/en-US/Login'])assert.equal(workdaySite(u),null);
});
test('all discovered employers are searched beyond the manual twenty, with working detail URLs and a run deadline',async()=>{
 let calls=0;const targets=Array.from({length:26},(_,n)=>`https://employer${n}.wd3.myworkdayjobs.com/en-US/Careers`);
 const api=new EmployerFeedDiscovery('workday','Fixture|'+root,{additionalTargets:targets,gapMs:0,fetch:async()=>{calls++;return Response.json({jobPostings:[{title:'Data Analyst',externalPath:'/job/Sydney/Analyst_R1',locationsText:'Sydney'}]});}});
 assert.equal((await api.search('Data Analyst',1)).length,27);assert.equal(calls,27);
 calls=0;const limited=new EmployerFeedDiscovery('workday',root,{additionalTargets:targets,gapMs:0,shouldStop:()=>calls>=3,fetch:async()=>{calls++;return Response.json({jobPostings:[]});}});await limited.search('Data Analyst',1);assert.equal(calls,3);
});
test('public search cache is reused across instances, expires, and never caches detail or failed requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workday-public-cache-'));let calls=0,now=10000000;
 try{const network:typeof fetch=async()=>{calls++;return Response.json({jobPostings:[]});};const url='https://fixture.wd105.myworkdayjobs.com/wday/cxs/fixture/Careers/jobs',init={method:'POST',body:JSON.stringify({searchText:'Data Analyst',limit:20,offset:0,appliedFacets:{}})};
 await workdaySearchCache(dir,network,()=>now)(url,init);await workdaySearchCache(dir,network,()=>now)(url,init);assert.equal(calls,1);
 await workdaySearchCache(dir,network,()=>now)(url,{...init,body:JSON.stringify({offset:20})});assert.equal(calls,2);
 now+=31*60_000;await workdaySearchCache(dir,network,()=>now)(url,init);assert.equal(calls,3);
 await workdaySearchCache(dir,network,()=>now)(url+'/R123');await workdaySearchCache(dir,network,()=>now)(url+'/R123');assert.equal(calls,5);
 let errors=0;const fail=workdaySearchCache(dir,async()=>{errors++;return new Response('',{status:429});},()=>now);await fail(url,{...init,body:'{}'});await fail(url,{...init,body:'{}'});assert.equal(errors,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
