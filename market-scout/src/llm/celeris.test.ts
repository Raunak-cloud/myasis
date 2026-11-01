import assert from 'node:assert/strict';
import {test} from 'node:test';
import {config} from '../config.js';
import {celerisChat} from './celeris.js';

test('marketing Magnus maps high to supported medium without requesting extra-high',async()=>{
 const originalFetch=globalThis.fetch,originalKey=config.celeris.apiKey;
 config.celeris.apiKey='fictional-provider-policy-key';
 try{
  const efforts:string[]=[];
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));
   const effort=body.chat_template_kwargs.reasoning_effort;
   assert.ok(['low','medium'].includes(effort),'the provider must never receive unsupported high or a level above the operator ceiling');
   efforts.push(effort);
   return Response.json({choices:[{message:{content:'Fictional complete answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
  }) as typeof fetch;
  for(const reasoningEffort of ['low','medium','high'] as const)await celerisChat({model:'celeris-1-magnus',messages:[],thinking:true,reasoningEffort});
  assert.deepEqual(efforts,['low','medium','medium']);
 }finally{globalThis.fetch=originalFetch;config.celeris.apiKey=originalKey;}
});
