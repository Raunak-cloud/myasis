import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeRepair, type RepairToolCall } from './repair-coder.js';

const incident = { runId: '1081', attemptId: 'e9cf35f9-b0c0-4209-95c6-849c51a774a5', category: 'repeated_tool_failure' as const, tool: 'create_file', count: 2 };
const file = 'seek-bot/src/agent/agent-files.ts';
const source = { [file]: 'old code', 'seek-bot/.env': 'SECRET', 'seek-bot/src/agent/application-policy.ts': 'protected policy' };
const model = (calls: RepairToolCall[]) => async () => ({ calls: [calls.shift()!], costUsd: .01 });

test('a repair is an isolated proposal, with explicit source access and bounded changes', async () => {
  const proposal = await proposeRepair(incident, source, model([
    { name: 'replace_source', args: { path: file, old: 'old', replacement: 'new' } },
  ]));
  assert.deepEqual(proposal.files, { [file]: 'new code' });
  assert.equal(source[file], 'old code');
  await proposeRepair(incident,source,async turns=>{
    assert.match(turns[1].content,/old code/);assert.doesNotMatch(turns[1].content,/SECRET|protected policy/);
    return {calls:[{name:'replace_source',args:{path:file,old:'old',replacement:'new'}}],costUsd:0};
  });
});

test('multiline edits match mixed Windows/Unix source without changing protected text',async()=>{
  const text='import { safe } from "./safe.js";\r\nconst approved = safe;\r\nfunction value() {\n  return 0;\r\n}\r\n';
  const proposal=await proposeRepair(incident,{[file]:text},model([{name:'replace_source',args:{path:file,old:'function value() {\n  return 0;\n}',replacement:'function value() {\n  return 1;\n}'}}]));
  assert.match(proposal.files[file],/return 1;/);assert.doesNotMatch(proposal.files[file],/\r/);
});

test('the exact failing function is supplied as source context after the source catalogue',async()=>{
  const code='function unrelated() { return "unrelated-body"; }\nexport function browserTarget(page: object) { return [page][1]; }';
  const path='seek-bot/src/agent/browser-target.ts';
  await proposeRepair({...incident,sourceSite:{path,function:'browserTarget'}},{[path]:code},async turns=>{
    const focus=turns[2].content;
    assert.match(focus,/FAILURE SITE SOURCE: seek-bot\/src\/agent\/browser-target.ts \/ browserTarget/);
    assert.match(focus,/return \[page\]\[1\]/);assert.doesNotMatch(focus,/unrelated-body/);
    return {calls:[{name:'replace_source',args:{path,old:'[page][1]',replacement:'page'}}],costUsd:0};
  });
});

test('secrets, approval policies, malformed edits and unbounded model usage fail closed', async () => {
  for (const path of ['seek-bot/.env', 'seek-bot/src/agent/application-policy.ts', '../agent-files.ts']) {
    await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'replace_source', args: { path,old:'old',replacement:'new' } }], costUsd: 0 })), /turn limit/);
  }
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'replace_source', args: { path: file, old: 'absent', replacement: 'x' } }], costUsd: 0 })), /turn limit/);
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [], costUsd: .51 })), /budget/);
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'finish', args: { summary: 'Nothing changed' } }], costUsd: 0 })), /declined/);
});
