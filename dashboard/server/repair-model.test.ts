import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miniMaxRepairModel, reviewRepair } from './repair-model.js';

test('MiniMax broker sends only proposal context and parses measured tool calls', async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'minimax/minimax-m3.1-flash');
    assert.doesNotMatch(JSON.stringify(body), /fixture-private-key/);
    assert.ok(body.tools.every((tool: { function: { name: string } }) => ['read_source', 'replace_source', 'finish'].includes(tool.function.name)));
    return Response.json({ usage: { cost: .002 }, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'read_source', arguments: '{"path":"test"}' } }] } }] });
  };
  const result = await miniMaxRepairModel('fixture-private-key', fetcher)([{ role: 'system', content: 'rules' }, { role: 'user', content: 'incident' }]);
  assert.deepEqual(result, { costUsd: .002, calls: [{ name: 'read_source', args: { path: 'test' } }] });
});

test('independent review has no tools and requires a measured explicit decision', async () => {
  const incident={runId:'1',attemptId:'fixture',category:'repeated_tool_failure' as const,count:2};
  const proposal={files:{source:'after'},summary:'fixture',costUsd:0};
  const fetcher:typeof fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.tools,undefined);
    assert.doesNotMatch(JSON.stringify(body),/private-key/);
    return Response.json({usage:{cost:.001},choices:[{message:{content:JSON.stringify({accepted:false,reason:'Speculative'})}}]});
  };
  assert.deepEqual(await reviewRepair('private-key',incident,{source:'before'},proposal,fetcher),{accepted:false,reason:'Speculative',costUsd:.001});
  await assert.rejects(()=>reviewRepair('key',incident,{},proposal,async()=>Response.json({choices:[]})),/unavailable/);
});

test('MiniMax broker rejects missing usage and incomplete responses', async () => {
  const model = miniMaxRepairModel('key', async () => Response.json({ choices: [] }));
  await assert.rejects(() => model([{ role: 'system', content: 'rules' }]), /charge was unavailable/);
  const truncated = miniMaxRepairModel('key', async () => Response.json({ usage: { cost: 0 }, choices: [{ finish_reason: 'length' }] }));
  await assert.rejects(() => truncated([{ role: 'system', content: 'rules' }]), /truncated/);
});

test('truncated proposal calls are discarded, corrected once, and both charges are retained',async()=>{
  const limits:number[]=[];
  const model=miniMaxRepairModel('key',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));limits.push(body.max_tokens);assert.equal(body.reasoning.effort,'medium');
    if(limits.length===1)return Response.json({usage:{cost:.001},choices:[{finish_reason:'length',message:{tool_calls:[{function:{name:'replace_source',arguments:'partial'}}]}}]});
    return Response.json({usage:{cost:.002},choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'read_source',arguments:'{"path":"safe"}'}}]}}]});
  });
  const result=await model([{role:'system',content:'rules'}]);
  assert.deepEqual(limits,[8192,16384]);assert.equal(result.costUsd,.003);assert.deepEqual(result.calls,[{name:'read_source',args:{path:'safe'}}]);
});

test('cancellation prevents a truncated-response resample and preserves its known charge',async()=>{
  let calls=0,checks=0;
  const model=miniMaxRepairModel('key',async()=>{calls++;return Response.json({usage:{cost:.001},choices:[{finish_reason:'length'}]});},async()=>++checks===1);
  await assert.rejects(()=>model([{role:'system',content:'rules'}]),(error:any)=>error.repairCostUsd===.001&&/paused/.test(error.message));
  assert.equal(calls,1);
});

test('source reads and edit feedback retain native tool-call/result correlation',async()=>{
  const model=miniMaxRepairModel('key',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.equal(body.messages[1].content,'incident');
    const assistant=body.messages[2],tool=body.messages[3];
    assert.equal(assistant.role,'assistant');assert.equal(assistant.tool_calls[0].function.name,'read_source');
    assert.equal(tool.role,'tool');assert.equal(tool.tool_call_id,assistant.tool_calls[0].id);assert.equal(tool.content,'source text');
    return Response.json({usage:{cost:0},choices:[{message:{tool_calls:[{function:{name:'finish',arguments:'{"summary":"fixture"}'}}]}}]});
  });
  await model([{role:'system',content:'rules'},{role:'user',content:'incident'},{role:'assistant',content:JSON.stringify({name:'read_source',args:{path:'safe'}})},{role:'tool',content:'source text'}]);
});
