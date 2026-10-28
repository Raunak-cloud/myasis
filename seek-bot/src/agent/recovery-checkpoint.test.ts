import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryCheckpoint, recoveryTools } from './recovery-checkpoint.js';
import { validToolInput } from './tool-input.js';
import type { Observation } from './observe.js';

const observation = (value = '', ref = 'f0'): Observation => ({ url: 'https://employer.invalid/apply', title: 'Apply',
  actions: [], text: 'Apply', fields: [{ ref, label: 'City', kind: 'text', required: true, currentValue: value }] });

test('repeated failures require a plan, a browser action, then fresh-result assessment', () => {
  const state = new RecoveryCheckpoint();
  state.observe(observation());
  state.acted('browser_action', true); state.observe(observation());
  assert.equal(state.tool, undefined);
  state.acted('browser_action', true); state.observe(observation());
  assert.equal(state.tool, 'record_recovery_plan');
  state.planned(); state.endTurn();
  assert.equal(state.tool, undefined, 'the plan itself does not execute the proposed repair');
  state.acted('browser_action', false); state.endTurn(); state.observe(observation('Sydney'));
  assert.equal(state.tool, 'record_recovery_result');
  state.verified('no_progress');
  assert.equal(state.tool, 'record_recovery_plan', 'failed verification requires another approach');
  state.planned(); state.acted('consult_application_specialist', false); state.endTurn();
  assert.equal(state.tool, 'record_recovery_result');
  state.verified('progress');
  assert.equal(state.tool, undefined);
});

test('unchanged inspections trigger recovery despite ref churn; changed values do not', () => {
  const stalled = new RecoveryCheckpoint(), healthy = new RecoveryCheckpoint();
  stalled.observe(observation()); healthy.observe(observation());
  for (let i = 1; i <= 5; i++) {
    stalled.acted('take_snapshot', false); stalled.observe(observation('', `f${i}`));
    healthy.acted('browser_action', false); healthy.observe(observation(`value-${i}`));
  }
  assert.equal(stalled.tool, 'record_recovery_plan');
  assert.equal(healthy.tool, undefined);
});

test('malformed checkpoint retries and inconclusive checks are bounded', () => {
  const state = new RecoveryCheckpoint();
  assert.equal(state.rejected(), false); assert.equal(state.rejected(), true);
  state.planned();
  state.verified('more_evidence'); assert.equal(state.tool, undefined);
  state.verified('more_evidence'); assert.equal(state.tool, 'record_recovery_plan');
  assert.equal(validToolInput({}, recoveryTools[0].parameters), false);
  assert.equal(validToolInput({ observed_issue: 'Unknown widget', evidence: [], previous_approaches: ['Bad query'],
    next_action: 'Inspect actual controls', verification: 'Observed option saved' }, recoveryTools[0].parameters), false);
});
