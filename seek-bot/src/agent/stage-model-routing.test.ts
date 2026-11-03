import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationChat,reviewChat,rankingChat } from './application-chat.js';
import { withApplicationModel } from '../application-model.js';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

test('stage routes preserve concurrent owner isolation, exact model IDs and no fallback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stage-routing-')),original=globalThis.fetch;
 const calls:Array<{url:string;key:string;body:any}>=[];
 const request={model:'celeris-1' as const,messages:[{role:'user' as const,content:'Fictional stage test.'}],maxTokens:1024};
 globalThis.fetch=async(url,init)=>{
  calls.push({url:String(url),key:new Headers(init?.headers).get('authorization')??'',body:JSON.parse(String(init?.body))});
  await Promise.resolve();
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:2,cost:0.00001}});
 };
 try {
  await Promise.all(['one','two','three'].map(owner=>withApplicationModel({DATA_DIR:join(dir,owner),COST_TRACKING:'false',APPLICATION_AI_MODEL:owner==='three'?'minimax':'celeris',
   CELERIS_API_KEY:owner+'-review',OPENROUTER_API_KEY:owner+'-apply',CELERIS_QUEUE_FILE:join(dir,'queue.sqlite'),CELERIS_MIN_INTERVAL_MS:'0'},async()=>{
    await Promise.all([reviewChat(request),rankingChat(request),applicationChat(request)]);
  })));
  assert.equal(calls.length,9);
  for(const owner of ['one','two','three']) {
   const scoped=calls.filter(call=>call.key.startsWith('Bearer '+owner+'-'));
   assert.equal(scoped.length,3);
   const review=scoped.find(call=>call.body.model==='celeris-1-magnus')!;
   assert.ok(review.url.includes('/celeris-1-magnus/'));assert.equal(review.key,'Bearer '+owner+'-review');
   assert.equal(review.body.chat_template_kwargs.enable_thinking,true);
   assert.equal(scoped.find(call=>call.body.model==='celeris-1')?.key,'Bearer '+owner+'-review');
   if(owner==='three') {
    const applying=scoped.find(call=>call.url==='https://openrouter.ai/api/v1/chat/completions')!;
    assert.equal(applying.body.model,'minimax/minimax-m3.1-flash');assert.equal(applying.key,'Bearer '+owner+'-apply');
    assert.equal(applying.body.models,undefined);assert.equal(applying.body.route,undefined);
   } else {
    assert.equal(scoped.filter(call=>call.body.model==='celeris-1-magnus').length,2,'review and application/supervision both use Magnus');
    assert.ok(scoped.every(call=>call.url.includes('/celeris-1')),'Magnus never calls OpenRouter');
    assert.ok(scoped.filter(call=>call.body.model==='celeris-1-magnus').every(call=>call.body.chat_template_kwargs.enable_thinking));
   }
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
 } finally {globalThis.fetch=original;closeCelerisQueues();rmSync(dir,{recursive:true,force:true});}
});
