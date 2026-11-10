import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GenerationRecovery,GenerationWindowError,boundedReasoningEffort} from './generation-recovery.js';
import {celerisReasoningEffort} from '../../../shared/reasoning-policy.mjs';

test('only explicit escalation can use Magnus xhigh and it receives a full initial inference window',()=>{
 assert.equal(celerisReasoningEffort('medium'),'medium');
 assert.equal(celerisReasoningEffort('high'),'xhigh');
 assert.equal(celerisReasoningEffort('unexpected'),'medium');
 const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[]},90_000,16_384);
 assert.ok(recovery.deadline-Date.now()>=100_000);
 const body={max_tokens:16_384,chat_template_kwargs:{enable_thinking:true,reasoning_effort:'xhigh'}};
 recovery.adapt(body,'unusable',true);
 assert.equal(body.chat_template_kwargs.reasoning_effort,'medium');
 assert.equal(body.max_tokens,16_384);
 assert.equal(recovery.timeoutMs,90_000);
});

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

test('deep reasoning cannot start with only leftover time after queue admission',()=>{
 const original=Date.now;let now=1_000_000;Date.now=()=>now;
 try{
  const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[]},90_000,16_384);
  recovery.assertWindow(0,true);
  now+=20_000;
  assert.throws(()=>recovery.assertWindow(0,true),GenerationWindowError);
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


test('an explicitly preserved effort survives output and timeout recovery without relaxing retry bounds',()=>{
 const recovery=new GenerationRecovery({model:'celeris-1-magnus',messages:[],reasoningEffort:'high',preserveReasoningEffort:true},60_000,8192);
 const body={max_tokens:8192,reasoning:{effort:'high'}};
 assert.equal(recovery.adapt(body,'unusable',true),true);
 assert.equal(body.reasoning.effort,'high');assert.equal(body.max_tokens,16_384);
 assert.equal(recovery.adapt(body,'timeout'),true);assert.equal(body.reasoning.effort,'high');
 assert.equal(recovery.adapt(body,'unusable',true),false);assert.ok(recovery.deadline<=recovery.hardDeadline);
});
