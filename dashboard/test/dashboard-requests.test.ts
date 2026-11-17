import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDashboardRequests} from '../src/dashboard-requests.js';

test('concurrent identical reads share one fetch and independently readable bodies; later reads stay fresh',async()=>{
 let calls=0;
 const shared=createDashboardRequests((async()=>{calls++;return new Response(JSON.stringify({version:calls}));}) as typeof fetch);
 const responses=await Promise.all(Array.from({length:12},()=>shared.get('/api/billing/status')));
 assert.equal(calls,1);
 for(const response of responses)assert.deepEqual(await response.json(),{version:1});
 assert.deepEqual(await (await shared.get('/api/billing/status')).json(),{version:2});
 assert.equal(calls,2);
 await Promise.all([shared.get('/api/billing/status'),shared.get('/api/entitlements')]);assert.equal(calls,4,'different URLs never share private results');
});
test('temporary failures retry, while 429 polling respects Retry-After before recovery',async()=>{
 let now=0,calls=0;
 const shared=createDashboardRequests((async()=>{calls++;return new Response('{}',{status:calls===1?503:calls===2?429:200,headers:{'Retry-After':'10'}});}) as typeof fetch,()=>now);
 assert.equal((await shared.get('/api/billing/status')).status,503);
 assert.equal((await shared.get('/api/billing/status')).status,429);
 now=9999;for(let i=0;i<20;i++)assert.equal((await shared.get('/api/billing/status')).status,429);
 assert.equal(calls,2);now=10_000;assert.equal((await shared.get('/api/billing/status')).status,200);assert.equal(calls,3);
});
test('account switches and mutation invalidation discard old in-flight results; writes cannot be replayed',async()=>{
 const pending:Array<{done:(response:Response)=>void;signal:AbortSignal}>=[];
 const shared=createDashboardRequests((async(_input,init)=>await new Promise<Response>(done=>pending.push({done,signal:init!.signal!}))) as typeof fetch);
 shared.setAccount('owner-a');const old=shared.get('/api/billing/status');const rejected=assert.rejects(old,{name:'AbortError'});await Promise.resolve();
 assert.equal(shared.setAccount('owner-b'),true);assert.equal(pending[0].signal.aborted,true);
 const next=shared.get('/api/billing/status');await Promise.resolve();pending[0].done(new Response('{"owner":"a"}'));pending[1].done(new Response('{"owner":"b"}'));
 await rejected;assert.deepEqual(await (await next).json(),{owner:'b'});
 const before=shared.get('/api/signin/session');const invalidated=assert.rejects(before,{name:'AbortError'});await Promise.resolve();shared.invalidate('/api/signin/session');
 const after=shared.get('/api/signin/session');await Promise.resolve();pending[2].done(new Response('{"on":true}'));pending[3].done(new Response('{"on":false}'));
 await invalidated;assert.deepEqual(await (await after).json(),{on:false});
 assert.equal(shared.setAccount('owner-b'),false);assert.equal(shared.setAccount(null),true);
 assert.equal('post' in shared,false,'no mutation or automatic submit/retry capability');
});
