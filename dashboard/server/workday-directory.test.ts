import assert from 'node:assert/strict';import test from 'node:test';import {expandedWorkdaySites,workdayCandidates} from './workday-directory.js';import type {query} from './db/index.js';
test('all users share discovered public employer roots; search is budgeted and repeated queries are reused',async()=>{
 const sites=new Map<string,string>(),searches=new Set<string>();let calls=0,budget=0;
 const db=(async(sql:string,p:any[]=[])=>{
 if(sql.includes('SELECT DISTINCT url,company'))return [{url:'https://history.wd1.myworkdayjobs.com/en-US/Careers/job/Sydney/Role_R2/apply?token=fictional',company:'History Employer'}];
 if(sql.startsWith('INSERT INTO workday_directory_searches')){if(searches.has(p[0]))return [];searches.add(p[0]);return [{query:p[0]}];}
 if(sql.startsWith('INSERT INTO workday_directory(')){sites.set(p[0],p[1]||sites.get(p[0])||'');return [];}
 if(sql.startsWith('SELECT site,label'))return [...sites].map(([site,label])=>({site,label}));
 throw Error('Unexpected SQL '+sql);
 }) as typeof query;
 const catalog={key:'fictional-search-key',reserveSearch:async()=>{budget++;return true;},targets:async()=>['https://indexed.wd3.myworkdayjobs.com/en-US/Careers']};
 const network:typeof fetch=async(input)=>{calls++;assert.equal(new URL(String(input)).searchParams.get('country'),'au');return Response.json({web:{results:[{url:'https://new.wd5.myworkdayjobs.com/en-US/Jobs/job/Sydney/Role_R1'},{url:'https://private.invalid/en-US/Jobs'}]}});};
 const options={db,catalog,network,now:()=>0};
 const a=await expandedWorkdaySites('Saved|https://saved.wd1.myworkdayjobs.com/en-US/Jobs','Data Analyst',true,options);assert.equal(a.length,4);assert.equal(calls,2);assert.equal(budget,2);assert.ok(a.every(v=>!v.includes('token=')));
 const b=await expandedWorkdaySites('Other|https://other.wd1.myworkdayjobs.com/en-US/Jobs','Data Analyst',true,options);assert.equal(b.length,5);assert.equal(calls,2);
 const c=await expandedWorkdaySites('', 'Nurse',false,options);assert.equal(c.length,5);assert.equal(calls,2,'approved application runs do not create discovery searches');
 assert.deepEqual(workdayCandidates([{url:'https://invalid.example/jobs'}]),[]);
});
