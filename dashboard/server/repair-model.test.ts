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
