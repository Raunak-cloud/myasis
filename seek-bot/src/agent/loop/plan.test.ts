import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolReaction } from './plan.js';

test('expected handoffs stop stale plans without classifying progress as failure', () => {
  assert.deepEqual(toolReaction({ kind: 'ok', disposition: 'reobserve', message: 'Verified 1 field. Not filled yet: new question.' }), { reobserve: true, failed: false });
  assert.deepEqual(toolReaction({ kind: 'ok', disposition: 'completed', message: 'Answered: describe what failed in a project.' }), { reobserve: false, failed: false });
});

test('real failures and malformed calls still trigger recovery', () => {
  for (const disposition of ['failed', 'invalid-arguments'] as const) {
    assert.deepEqual(toolReaction({ kind: 'ok', disposition, message: 'Try another approach.' }), { reobserve: true, failed: true });
  }
  assert.deepEqual(toolReaction({ kind: 'ok', message: 'Tool failed: rejected selection.' }), { reobserve: true, failed: true });
});
