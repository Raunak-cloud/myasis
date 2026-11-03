import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationChat,reviewChat,rankingChat } from './application-chat.js';
import { withApplicationModel } from '../application-model.js';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

test('stage routes preserve concurrent owner isolation, exact model IDs and no fallback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stage-routing-')),original=globalThis.fetch;
 const previousCostTracking=process.env.COST_TRACKING;
 process.env.COST_TRACKING='true';
 const calls:Array<{url:string;key:string;body:any}>=[];
 const request={model:'celeris-1' as const,messages:[{role:'user' as const,content:'Fictional stage test.'}],maxTokens:1024};
 globalThis.fetch=async(url,init)=>{
  calls.push({url:String(url),key:new Headers(init?.headers).get('authorization')??'',body:JSON.parse(String(init?.body))});
  await Promise.resolve();
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:2,cost:0.00001}});
 };
 try {
  await Promise.all(['one','two','three','four'].map(owner=>withApplicationModel({DATA_DIR:join(dir,owner),COST_TRACKING:'true',APPLICATION_AI_MODEL:owner==='four'?'deepseek':owner==='three'?'minimax':'celeris',
   CELERIS_API_KEY:owner+'-review',OPENROUTER_API_KEY:owner+'-apply',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0'},async()=>{
    await Promise.all([reviewChat(request),rankingChat(request),applicationChat(request)]);
  })));
  assert.equal(calls.length,12);
  for(const owner of ['one','two','three','four']) {
   const scoped=calls.filter(call=>call.key.startsWith('Bearer '+owner+'-'));
   assert.equal(scoped.length,3);
   if(owner==='three'||owner==='four') {
    for(const call of scoped) {
     assert.equal(call.url,'https://openrouter.ai/api/v1/chat/completions');
     assert.equal(call.body.model,owner==='four'?'deepseek/deepseek-v4.1-flash-1017':'minimax/minimax-m3.1-flash');assert.equal(call.key,'Bearer '+owner+'-apply');
     assert.equal(call.body.models,undefined);assert.equal(call.body.route,undefined);
    }
   } else {
    const review=scoped.find(call=>call.body.model==='celeris-1-magnus')!;
    assert.ok(review.url.includes('/celeris-1-magnus/'));assert.equal(review.key,'Bearer '+owner+'-review');
    assert.equal(scoped.find(call=>call.body.model==='celeris-1')?.key,'Bearer '+owner+'-review');
    assert.equal(scoped.filter(call=>call.body.model==='celeris-1-magnus').length,2,'review and application/supervision both use Magnus');
    assert.ok(scoped.every(call=>call.url.includes('/celeris-1')),'Magnus never calls OpenRouter');
    assert.ok(scoped.filter(call=>call.body.model==='celeris-1-magnus').every(call=>call.body.chat_template_kwargs.enable_thinking));
   }
   const ledger=readFileSync(join(dir,owner,'cost-ledger.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
   const usage=ledger.filter(entry=>entry.kind==='usage');
   assert.equal(usage.length,3);
   assert.ok(usage.every(entry=>entry.provider===(owner==='three'||owner==='four'?'OpenRouter':'Celeris')),'only the selected provider incurs usage');
  }
  assert.equal(request.model,'celeris-1','routes never mutate caller input');
  const before=calls.length;
  await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false'},async()=>{
   await assert.rejects(reviewChat(request),/CELERIS_API_KEY/);
   await assert.rejects(applicationChat(request),/CELERIS_API_KEY/);
  });
  assert.equal(calls.length,before,'missing stage credentials never use a process/provider fallback');
  let errors=0;
  globalThis.fetch=async(url)=>{errors++;assert.ok(String(url).includes('celeris-1-magnus'));return Response.json({error:{message:'fixture invalid request'}},{status:400});};
  await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false',CELERIS_API_KEY:'review',OPENROUTER_API_KEY:'apply',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0'},async()=>{
   await assert.rejects(reviewChat(request));
  });
  assert.equal(errors,1,'a failed review never switches to MiniMax');
  globalThis.fetch=async(url)=>{errors++;assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');return Response.json({error:{message:'fixture invalid request'}},{status:400});};
  await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false',APPLICATION_AI_MODEL:'minimax',CELERIS_API_KEY:'unused',OPENROUTER_API_KEY:'apply'},async()=>{
   for(const route of [reviewChat,rankingChat,applicationChat])await assert.rejects(route(request));
  });
  assert.equal(errors,4,'a failed MiniMax stage never switches to Celeris');
  const beforeMissing=errors;
  await withApplicationModel({DATA_DIR:dir,COST_TRACKING:'false',APPLICATION_AI_MODEL:'minimax',CELERIS_API_KEY:'unused'},async()=>{
   for(const route of [reviewChat,rankingChat,applicationChat])await assert.rejects(route(request),/OPENROUTER_API_KEY/);
  });
  assert.equal(errors,beforeMissing,'missing MiniMax credentials fail before any HTTP request');
 } finally {globalThis.fetch=original;closeCelerisQueues();rmSync(dir,{recursive:true,force:true});
  if(previousCostTracking===undefined)delete process.env.COST_TRACKING;else process.env.COST_TRACKING=previousCostTracking;}
});
