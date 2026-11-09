import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RunPool } from './runner.js';
import { PREPAID_RETRY_SUBMITTED } from '../../seek-bot/src/technical-retry-types.js';

test('actual runner counts prepaid retries once without charging and keeps other owners and ordinary submissions separate',async()=>{
 const pool=new RunPool() as any;
 const make=(owner:string)=>{
  const run=pool.forUser(owner) as any;
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),connected:true,send:()=>true});
  let charges=0;run.onApplicationSubmitted=()=>{charges++;};
  // The real message/stdout handlers and supervisor run; no browser, database or employer starts.
  run.finishChild=async()=>{};
  run.spawnChild(child,owner,'/unused-fixture','run','1',{deadlineAt:Date.now()+60_000});
  return {run,child,charges:()=>charges};
 };
 const one=make('fixture-one'),two=make('fixture-two');
 const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
 try{
  one.run.prepaidRetryIds.add(first);two.run.prepaidRetryIds.add(second);
  one.child.stdout.write('  ✅ saved application submitted\n');
  one.child.emit('message',{type:PREPAID_RETRY_SUBMITTED,reviewId:first});
  one.child.emit('message',{type:PREPAID_RETRY_SUBMITTED,reviewId:first});
  two.child.emit('message',{type:PREPAID_RETRY_SUBMITTED,reviewId:first});
  assert.equal(one.run.state.applied,1);assert.equal(one.charges(),0);
  assert.equal(two.run.state.applied,0);assert.equal(two.charges(),0);
  one.child.stdout.write('  ✅ submitted (2/3)\n');
  assert.equal(one.run.state.applied,2);assert.equal(one.charges(),1,'ordinary successful applications keep their normal credit accounting');
  two.child.emit('message',{type:PREPAID_RETRY_SUBMITTED,reviewId:second});
  assert.equal(two.run.state.applied,1);assert.equal(two.charges(),0);
 }finally{
  for(const {child} of [one,two]){child.emit('exit',0,null);child.emit('close',0,null);}
  await Promise.all([one.run.completion,two.run.completion]);
 }
});
