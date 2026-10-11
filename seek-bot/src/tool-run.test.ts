import assert from 'node:assert/strict';
import test from 'node:test';
import { AbandonedStepError, abandoned, assertLive, toolRun, type ToolRun } from './tool-run.js';

test('outside any tool call nothing is abandoned', () => {
  assert.equal(abandoned(), false);
  assert.doesNotThrow(assertLive);
});

test('a call marked retired is refused after its await, the live one is not', async () => {
  const stale: ToolRun = { generation: 1, retired: false };
  const live: ToolRun = { generation: 2, retired: false };
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const staleWrite = toolRun.run(stale, async () => { await gate; assertLive(); });
  stale.retired = true; // its time limit passed while it waited on a model call
  await toolRun.run(live, async () => assertLive());
  release();
  await assert.rejects(staleWrite, AbandonedStepError);
});
