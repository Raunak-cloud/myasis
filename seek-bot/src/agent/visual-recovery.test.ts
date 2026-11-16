import assert from 'node:assert/strict';
import test from 'node:test';
import { VisualRecovery } from './visual-recovery.js';
import type { Observation } from './observe.js';
const page = (value = '', ref = 'f0'): Observation => ({ url: 'https://fixture.invalid/apply', title: 'Application', text: 'Institution required', actions: [], fields: [{ ref, label: 'Institution', kind: 'text', required: true, currentValue: value }] });
test('two invalid calls trigger a screenshot; normal actions stay available and recovery stops after two further errors', () => {
  const recovery = new VisualRecovery(); recovery.observe(page());
  recovery.record('browser_action', 'script', 'invalid-arguments', 'Invalid tool input: script is required.');
  assert.equal(recovery.observe(page()).screenshot, false);
  recovery.record('browser_action', 'script', 'invalid-arguments', 'Invalid tool input: script is required.');
  const decision = recovery.observe(page());
  assert.equal(decision.screenshot, true); assert.match(decision.note, /script is required/); assert.match(decision.note, /no action is locked/);
  recovery.screenshotCaptured(true);
  recovery.record('browser_action', 'script', 'invalid-arguments', 'Invalid tool input: script is required.');
  assert.equal(recovery.observe(page()).stop, false);
  recovery.record('browser_action', 'script', 'invalid-arguments', 'Invalid tool input: script is required.');
  assert.equal(recovery.observe(page()).stop, true);
});
test('three unchanged observations trigger recovery despite changed refs; real progress clears it', () => {
  const recovery = new VisualRecovery(); recovery.observe(page());
  assert.equal(recovery.observe(page('', 'f4')).screenshot, false);
  assert.equal(recovery.observe(page('', 'f7')).screenshot, false);
  assert.equal(recovery.observe(page('', 'f9')).screenshot, true);
  recovery.screenshotCaptured(true);
  assert.equal(recovery.observe(page('SHIATS')).stop, false);
  assert.equal(recovery.observe(page('SHIATS')).screenshot, false);
});
test('distinct candidate evidence is progress; repeated identical reads are not', () => {
  const recovery = new VisualRecovery(); recovery.observe(page());
  for (let index = 0; index < 4; index++) {
    recovery.record('read_candidate_evidence', undefined, undefined, `Evidence passage ${index}`);
    assert.equal(recovery.observe(page()).screenshot, false);
  }
  for (let index = 0; index < 3; index++) recovery.observe(page());
  assert.equal(recovery.observe(page()).screenshot, true);
});
test('failed captures never claim a screenshot review happened', () => {
  const recovery = new VisualRecovery(); recovery.observe(page());
  recovery.observe(page()); recovery.observe(page()); recovery.observe(page());
  recovery.screenshotCaptured(false);
  assert.equal(recovery.observe(page()).stop, false);
  recovery.screenshotCaptured(false);
  assert.equal(recovery.observe(page()).stop, true);
});
