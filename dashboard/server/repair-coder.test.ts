import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeRepair, type RepairToolCall } from './repair-coder.js';

const incident = { runId: '1081', attemptId: 'e9cf35f9-b0c0-4209-95c6-849c51a774a5', category: 'repeated_tool_failure' as const, tool: 'create_file', count: 2 };
const file = 'seek-bot/src/agent/agent-files.ts';
const source = { [file]: 'old code', 'seek-bot/.env': 'SECRET', 'seek-bot/src/agent/application-policy.ts': 'protected policy' };
const model = (calls: RepairToolCall[]) => async () => ({ calls: [calls.shift()!], costUsd: .01 });

test('a repair is an isolated proposal, with explicit source access and bounded changes', async () => {
  const proposal = await proposeRepair(incident, source, model([
    { name: 'read_source', args: { path: file } },
    { name: 'replace_source', args: { path: file, old: 'old', replacement: 'new' } },
    { name: 'finish', args: { summary: 'Repair file handling' } },
  ]));
  assert.deepEqual(proposal.files, { [file]: 'new code' });
  assert.equal(source[file], 'old code');
});

test('secrets, approval policies, malformed edits and unbounded model usage fail closed', async () => {
  for (const path of ['seek-bot/.env', 'seek-bot/src/agent/application-policy.ts', '../agent-files.ts']) {
    await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'read_source', args: { path } }], costUsd: 0 })), /turn limit/);
  }
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'replace_source', args: { path: file, old: 'absent', replacement: 'x' } }], costUsd: 0 })), /turn limit/);
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [], costUsd: .51 })), /budget/);
  await assert.rejects(() => proposeRepair(incident, source, async () => ({ calls: [{ name: 'finish', args: { summary: 'Nothing changed' } }], costUsd: 0 })), /turn limit/);
});
