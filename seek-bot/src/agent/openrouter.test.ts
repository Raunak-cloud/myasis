import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApplicationModel, MINIMAX_APPLICATION_MODEL } from '../application-model.js';
import { applicationChat } from './application-chat.js';
import { CostMeter, ApplicationBudgetExhaustedError, type ChatMessage, type CelerisRequest } from './celeris.js';
import { agentOnlyTranscript, latestObservationScreenshotOnly } from './agent-only-transcript.js';
import { validToolInput } from './tool-input.js';

const tool = { name: 'browser_action', description: 'Use the native browser', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } };
const reply = (cost = 0.001, finish = 'tool_calls') => ({ choices: [{ finish_reason: finish, message: {
  role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-provider-block', index: 0 }],
  tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'browser_action', arguments: '{"action":"inspect"}' } }],
} }], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 500 }, completion_tokens: 100, cost } });

test('DeepSeek retains screenshots, canonical tool arguments, reasoning continuation and its own charges', async()=>isolated(async()=>{
 const conditional={...tool,parameters:{type:'object',properties:{action:{type:'string'},sends_application:{type:'boolean'}},
  required:['action'],anyOf:[{required:['sends_application']},{properties:{action:{enum:['inspect']}}}]}};
 const requests:any[]=[];
 globalThis.fetch=async(url,init)=>{
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fictional-private-key');
  const body=JSON.parse(String(init?.body));requests.push(body);
  assert.equal(body.model,'deepseek/deepseek-v4.1-flash');
  assert.equal(body.temperature,undefined);assert.deepEqual(body.reasoning,{effort:'high'});
  assert.deepEqual(body.tools[0].function.parameters.required,['arguments_json']);
  const response=reply(.007);response.choices[0].message.tool_calls[0].function.arguments=JSON.stringify({arguments_json:JSON.stringify({action:'click',sends_application:false})});
  return Response.json(response);
 };
 const meter=new CostMeter(1),messages:ChatMessage[]=[{role:'user',content:[{type:'text',text:'Current fictional form.'},
  {type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}];
 const response=await applicationChat({model:'celeris-1-magnus',messages,tools:[conditional],reasoningEffort:'medium',meter});
 assert.deepEqual(response.toolCalls[0].args,{action:'click',sends_application:false});
 assert.equal(validToolInput(response.toolCalls[0].args,conditional.parameters),true);
 messages.push(response.message,{role:'tool',tool_call_id:'call-one',content:'Observed click complete.'});
 await applicationChat({model:'celeris-1-magnus',messages,tools:[conditional],meter});
 assert.deepEqual(requests[0].messages[0],messages[0]);
 assert.deepEqual(requests[1].messages[1].reasoning_details,reply().choices[0].message.reasoning_details);
 assert.equal(meter.totals.costUsd,.014);
 await withApplicationModel({APPLICATION_AI_MODEL:'deepseek',CELERIS_API_KEY:'unused'},async()=>{
  await assert.rejects(applicationChat({model:'celeris-1-magnus',messages:[]}),/OPENROUTER_API_KEY/);
 });
 assert.equal(requests.length,2,'no credential or provider fallback');
},'deepseek'));

test('DeepSeek generation recovery uses supported low effort, bounded output growth and the original spend meter',async()=>isolated(async()=>{
 const originalNow=Date.now,originalTimeout=AbortSignal.timeout,originalRandom=Math.random;
 let elapsed=0;const requests:any[]=[],windows:number[]=[];
 Date.now=()=>originalNow()+elapsed;Math.random=()=>0;
 AbortSignal.timeout=ms=>{windows.push(ms);return originalTimeout(ms);};
 try{
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   assert.equal(body.model,'deepseek/deepseek-v4.1-flash');
   if(requests.length===1){assert.equal(body.reasoning.effort,'high');elapsed+=31_000;return Response.json(reply(.001,'length'));}
   assert.equal(windows.at(-1),90_000);assert.equal(body.max_tokens,16_384);assert.equal(body.reasoning.effort,'low');
   assert.match(JSON.stringify(body.messages),/Exact candidate approval/);
   if(requests.length===2){elapsed+=90_000;throw new DOMException('Fixture inference timed out','TimeoutError');}
   return Response.json(reply());
  };
  const meter=new CostMeter(1);
  const response=await applicationChat({model:'celeris-1-magnus',messages:[{role:'user',content:'Exact candidate approval'}],tools:[tool],maxTokens:8192,meter});
  assert.equal(response.toolCalls[0].name,tool.name);assert.equal(requests.length,3);assert.equal(meter.totals.calls,3);
 }finally{Date.now=originalNow;AbortSignal.timeout=originalTimeout;Math.random=originalRandom;}
},'deepseek'));

test('MiniMax wire projection leaves canonical dispatch validation and returned arguments unchanged', async () => isolated(async () => {
  const conditional = { ...tool, parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['click', 'inspect'] }, sends_application: { type: 'boolean' },
  }, required: ['action'], anyOf: [
    { properties: { action: { enum: ['click'] } }, required: ['sends_application'] },
    { properties: { action: { enum: ['inspect'] } } },
  ] } };
  const original = structuredClone(conditional);
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    assert.deepEqual(body.tools[0].function.parameters.required, ['arguments_json']);
    assert.match(body.tools[0].function.description, /sends_application/);
    const response = reply();
    response.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ arguments_json: '{"action":"click"}' });
    return Response.json(response);
  }) as typeof fetch;
  const result = await applicationChat({ model: 'celeris-1-magnus', messages: [], tools: [conditional] });
  assert.deepEqual(result.toolCalls[0].args, { action: 'click' }, 'transport must not invent missing consent or retry tokens');
  assert.ok(result.message.role === 'assistant');
  assert.match(result.message.tool_calls![0].function.arguments, /arguments_json/, 'provider transcript retains its original wire arguments');
  assert.equal(validToolInput(result.toolCalls[0].args, conditional.parameters), false);
  assert.deepEqual(conditional, original);
}));

async function isolated(work: () => Promise<void>, selection = 'minimax') {
  const original = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-openrouter-'));
  try {
    await withApplicationModel({ APPLICATION_AI_MODEL: selection, OPENROUTER_API_KEY: 'fictional-private-key', DATA_DIR: directory }, work);
  } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }); }
}

test('MiniMax receives the full tools, screenshot, forced tool and unchanged reasoning continuation', async () => isolated(async () => {
  const requests: Record<string, any>[] = [];
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((options!.headers as Record<string, string>).authorization, 'Bearer fictional-private-key');
    requests.push(JSON.parse(String(options!.body)));
    return Response.json(reply());
  }) as typeof fetch;
  const meter = new CostMeter(1);
  const messages: ChatMessage[] = [{ role: 'system', content: 'Complete the synthetic application.' },
    { role: 'user', content: [{ type: 'text', text: 'Current page' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }];
  const request: CelerisRequest = { model: 'celeris-1-magnus', messages, tools: [tool], requireTool: true,
    forceTool: tool.name, thinking: true, reasoningEffort: 'high', maxTokens: 8192, meter };
  const result = await applicationChat(request);
  assert.equal(result.toolCalls[0].args.action, 'inspect');
  messages.push(result.message, { role: 'tool', tool_call_id: 'call-one', content: 'Inspection complete' });
  const transcript = agentOnlyTranscript(latestObservationScreenshotOnly(messages), 10000);
  await applicationChat({ ...request, messages: transcript });
  assert.equal(requests[0].model, MINIMAX_APPLICATION_MODEL);
  assert.deepEqual(requests[0].tools, [{ type: 'function', function: tool }]);
  assert.deepEqual(requests[0].tool_choice, { type: 'function', function: { name: tool.name } });
  assert.deepEqual(requests[0].messages[1], messages[1]);
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
  assert.deepEqual(requests[1].messages[2].reasoning_details, reply().choices[0].message.reasoning_details);
  assert.equal(meter.totals.costUsd, 0.002, 'provider cost overrides cheaper published estimates');
  assert.equal(meter.totals.cachedPromptTokens, 1000);
}));

test('a charged truncated response cannot resample past the application budget', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json(reply(0.2, 'length')); }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], meter: new CostMeter(0.2) }), ApplicationBudgetExhaustedError);
  assert.equal(calls, 1);
}));

test('one incomplete generation is retried without replaying tool actions and preserves its cost', async () => isolated(async () => {
  const requests: any[] = [];
  globalThis.fetch = (async (_url, options) => {
    requests.push(JSON.parse(String(options!.body)));
    return Response.json(reply(0.001, requests.length === 1 ? 'length' : 'tool_calls'));
  }) as typeof fetch;
  const meter = new CostMeter(1);
  await applicationChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Page' }], tools: [tool], maxTokens: 8192, meter });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].max_tokens, 16384);
  assert.equal(requests[1].messages.length, 2);
  assert.equal(meter.totals.calls, 2);
}));

test('MiniMax adapts a truncated review and a timed-out resample without a shortened final attempt', async()=>isolated(async()=>{
 const originalNow=Date.now,originalTimeout=AbortSignal.timeout,originalRandom=Math.random;
 let elapsed=0;const requests:any[]=[],windows:number[]=[];
 Date.now=()=>originalNow()+elapsed;Math.random=()=>0;
 AbortSignal.timeout=ms=>{windows.push(ms);return originalTimeout(ms);};
 try{
  globalThis.fetch=(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   if(requests.length===1){elapsed+=31_000;return Response.json(reply(.001,'length'));}
   assert.equal(windows.at(-1),90_000);assert.equal(body.max_tokens,16_384);
   assert.match(JSON.stringify(body.messages),/Exact candidate approval/);
   if(requests.length===2){assert.equal(body.reasoning.effort,'medium');elapsed+=90_000;throw new DOMException('Fixture inference timed out','TimeoutError');}
   assert.equal(body.reasoning.effort,'low');return Response.json(reply());
  }) as typeof fetch;
  const meter=new CostMeter(1);
  const result=await applicationChat({model:'celeris-1-magnus',messages:[{role:'system',content:'Controls'},{role:'user',content:'Exact candidate approval'}],
    tools:[tool],forceTool:tool.name,thinking:true,reasoningEffort:'high',maxTokens:8192,meter});
  assert.equal(result.toolCalls[0].name,tool.name);assert.equal(requests.length,3);
  assert.equal(meter.totals.calls,3,'all retry requests remain in the same usage meter');
  assert.ok(requests.every(body=>body.model===MINIMAX_APPLICATION_MODEL),'no cross-provider fallback');
 }finally{Date.now=originalNow;AbortSignal.timeout=originalTimeout;Math.random=originalRandom;}
}));

test('auth failures do not retry, do not expose credentials and never switch providers', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: 'Invalid fictional-private-key', code: 401 } }, { status: 401 }); }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [] }), error => {
    assert.match(String(error), /OpenRouter 401/);
    assert.doesNotMatch(String(error), /fictional-private-key/);
    return true;
  });
  assert.equal(calls, 1);
  await withApplicationModel({ APPLICATION_AI_MODEL: 'minimax' }, async () => {
    await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [] }), /OPENROUTER_API_KEY/);
  });
  assert.equal(calls, 1);
}));

test('unreported charges reserve a nonzero budget instead of granting unlimited turns', async () => isolated(async () => {
  globalThis.fetch = (async () => {
    const payload: any = reply(); delete payload.usage;
    return Response.json(payload);
  }) as typeof fetch;
  const meter = new CostMeter(0.0001);
  await applicationChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Page' }], meter });
  assert.equal(meter.exhausted, true);
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], meter }), ApplicationBudgetExhaustedError);
}));

test('failed HTTP200 generations retry inference only, discard partial calls and retain both charges', async()=>isolated(async()=>{
 const originalRandom=Math.random;Math.random=()=>0;
 try{
  const requests:any[]=[];
  globalThis.fetch=(async(_url,options)=>{
   requests.push(JSON.parse(String(options!.body)));
   if(requests.length===1){const bad=reply(.003,'error');bad.choices[0].message.tool_calls[0].function.arguments='{"action":"click","selector":"#send"}';return Response.json(bad);}
   return Response.json(reply(.001));
  }) as typeof fetch;
  const meter=new CostMeter(1),messages:ChatMessage[]=[{role:'user',content:'Current saved form. No new send has happened.'}];
  const result=await applicationChat({model:'celeris-1-magnus',messages,tools:[tool],maxTokens:8192,meter});
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0],'same model, tools, transcript and token allowance; no failed tool appended or replayed');
  assert.equal(result.toolCalls[0].args.action,'inspect','failed generation cannot leak its partial send call');
  assert.equal(meter.totals.calls,2);assert.equal(meter.totals.costUsd,.004);
 }finally{Math.random=originalRandom;}
}));

test('choice-level transient errors are retried while explicit auth errors and content filters stop', async()=>isolated(async()=>{
 const originalRandom=Math.random;Math.random=()=>0;
 try{
  let calls=0;
  globalThis.fetch=(async()=>++calls===1?Response.json({choices:[{finish_reason:'error',error:{code:429,message:'Synthetic capacity limit'}}],usage:{cost:.001}}):Response.json(reply())) as typeof fetch;
  await applicationChat({model:'celeris-1-magnus',messages:[],meter:new CostMeter(1)});assert.equal(calls,2);
  for(const code of [400,401,402,403]){
   calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({choices:[{finish_reason:'error',error:{code,message:'Synthetic fictional-private-key rejection'}}]});}) as typeof fetch;
   await assert.rejects(applicationChat({model:'celeris-1-magnus',messages:[]}),error=>{assert.match(String(error),new RegExp('OpenRouter '+code));assert.doesNotMatch(String(error),/fictional-private-key/);return true;});assert.equal(calls,1);
  }
  calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({choices:[{finish_reason:'content_filter'}],usage:{cost:.001}});}) as typeof fetch;
  await assert.rejects(applicationChat({model:'celeris-1-magnus',messages:[]}),/content_filter/);assert.equal(calls,1,'policy failures never enter empty-message recovery');
 }finally{Math.random=originalRandom;}
}));

test('failed generations with no message remain bounded by attempts and the original application budget', async()=>isolated(async()=>{
 const originalRandom=Math.random;Math.random=()=>0;
 try{
  let calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({choices:[{finish_reason:'error'}],usage:{prompt_tokens:100,completion_tokens:1,cost:.001}});}) as typeof fetch;
  await assert.rejects(applicationChat({model:'celeris-1-magnus',messages:[],meter:new CostMeter(1)}),/finish_reason=error/);assert.equal(calls,3);
  calls=0;await assert.rejects(applicationChat({model:'celeris-1-magnus',messages:[],meter:new CostMeter(.001)}),ApplicationBudgetExhaustedError);assert.equal(calls,1);
 }finally{Math.random=originalRandom;}
}));

test('structured specialist responses use MiniMax and a server retry respects the remaining deadline', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options!.body));
    assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'reply', schema: { type: 'object' } } });
    return Response.json({ error: { code: 429, message: 'Synthetic rate limit' } }, { status: 429, headers: { 'Retry-After': '10' } });
  }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], responseSchema: { type: 'object' }, deadline: Date.now() + 1000 }), /retry deadline/);
  assert.equal(calls, 1, 'must not shorten Retry-After to retry early');
}));

test('model routing and credentials stay isolated across simultaneous Celeris and MiniMax turns', async () => isolated(async () => {
  const providers: string[] = [];
  globalThis.fetch = (async (url, options) => {
    const body = JSON.parse(String(options!.body));
    const auth = (options!.headers as Record<string, string>).authorization;
    if (String(url).includes('openrouter.ai')) {
      assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
      assert.equal(auth, 'Bearer fictional-private-key'); providers.push('minimax');
    } else {
      assert.equal(body.model, 'celeris-1-magnus');
      assert.equal(auth, 'Bearer fictional-celeris-only'); providers.push('celeris');
    }
    return Response.json(reply());
  }) as typeof fetch;
  await Promise.all([
    applicationChat({ model: 'celeris-1-magnus', messages: [] }),
    withApplicationModel({ APPLICATION_AI_MODEL: 'celeris', CELERIS_API_KEY: 'fictional-celeris-only',
      CELERIS_MAX_CONCURRENT_REQUESTS: '0' }, () => applicationChat({ model: 'celeris-1-magnus', messages: [] })),
  ]);
  assert.deepEqual(providers.sort(), ['celeris', 'minimax']);
}));
