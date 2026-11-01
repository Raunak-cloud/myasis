import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GenerationRecovery,GenerationWindowError,boundedReasoningEffort} from './generation-recovery.js';

test('recovery never extends an enclosing deadline or sends a shortened retry after queue delay',()=>{
 const original=Date.now;let now=1_000_000;Date.now=()=>now;
 try{
  const deadline=now+100_000;
  const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[],deadline},45_000,8192);
  const body={max_tokens:8192,chat_template_kwargs:{enable_thinking:true,reasoning_effort:'high'}};
  recovery.adapt(body,'unusable',true);
  assert.equal(recovery.deadline,deadline);
  recovery.assertWindow(1);
  now+=15_001; // Shared queue consumed the inference reserve.
  assert.throws(()=>recovery.assertWindow(1),GenerationWindowError);
  recovery.refreshWindow();
  assert.throws(()=>recovery.assertWindow(1),GenerationWindowError);
 }finally{Date.now=original;}
});

test('repeated transport failures cannot refresh beyond the operation ceiling',()=>{
 const original=Date.now;let now=1_000_000;Date.now=()=>now;
 try{
  const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[]},45_000,8192);
  const hard=recovery.hardDeadline;
  for(let i=0;i<8;i++){now+=30_000;recovery.refreshWindow();assert.ok(recovery.deadline<=hard);}
  assert.throws(()=>recovery.assertWindow(1),GenerationWindowError);
 }finally{Date.now=original;}
});

test('untyped reasoning inputs cannot exceed high and recovery never switches thinking off',()=>{
 assert.equal(boundedReasoningEffort('unsupported effort','low'),'high');
 assert.equal(boundedReasoningEffort(undefined,'medium'),'medium');
 const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[]},45_000,8192);
 const body={max_tokens:8192,chat_template_kwargs:{enable_thinking:true,reasoning_effort:'high'}};
 recovery.adapt(body,'unusable',true);
 assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'medium'});
 recovery.adapt(body,'timeout');
 assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'low'});
 assert.equal(recovery.adapt(body,'unusable',true),false,'unusable replies get only one resample');
});
