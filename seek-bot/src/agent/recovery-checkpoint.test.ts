import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryCheckpoint, recoveryInput, recoveryTools } from './recovery-checkpoint.js';
import { validToolInput } from './tool-input.js';
import type { Observation } from './observe.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const observation = (value = '', ref = 'f0'): Observation => ({ url: 'https://employer.invalid/apply', title: 'Apply',
  actions: [], text: 'Apply', fields: [{ ref, label: 'City', kind: 'text', required: true, currentValue: value }] });

test('higher reasoning persists through inspection, repair execution and result assessment', () => {
 const state = new RecoveryCheckpoint(); state.observe(observation());
 assert.equal(state.needsDeepReasoning, false);
 state.acted('browser_action', true, { action: 'click' }); state.observe(observation());
 assert.equal(state.needsDeepReasoning, true);
 state.planned(); state.acted('take_snapshot', false); state.endTurn(); state.observe(observation());
 assert.equal(state.needsDeepReasoning, true, 'reading another screenshot is not recovery');
 state.acted('browser_action', false, { action: 'fill' }); state.endTurn(); state.observe(observation('Sydney'));
 assert.equal(state.needsDeepReasoning, true, 'saved change still needs agent assessment');
 state.verified('progress'); assert.equal(state.needsDeepReasoning, false);
});

test('changing DOM identities do not disguise repeated unchanged pages', () => {
 const state=new RecoveryCheckpoint();state.observe(observation());
 for(let i=0;i<5;i++){
  state.acted('take_snapshot',false);
  state.observe({...observation(),fields:[{...observation().fields[0],controlIdentity:'new-generated-id-'+i}]});
 }
 assert.equal(state.tool,'record_recovery_plan');
});

test('repeated failures require a plan, a browser action, then fresh-result assessment', () => {
  const state = new RecoveryCheckpoint();
  state.observe(observation());
  state.acted('browser_action', true); state.observe(observation());
  assert.equal(state.tool, undefined);
  state.acted('browser_action', true); state.observe(observation());
  assert.equal(state.tool, 'record_recovery_plan');
  state.planned(); state.endTurn();
  assert.equal(state.tool, undefined, 'the plan itself does not execute the proposed repair');
  state.acted('browser_action', false, { action: 'fill' }); state.endTurn(); state.observe(observation('Sydney'));
  assert.equal(state.tool, 'record_recovery_result');
  state.verified('no_progress');
  assert.equal(state.tool, 'record_recovery_plan', 'failed verification requires another approach');
  state.planned(); state.acted('consult_application_specialist', false); state.endTurn();
  assert.equal(state.tool, undefined, 'consultation is inspection, not executing a repair');
  state.acted('take_snapshot', false); state.endTurn(); state.observe(observation('Sydney'));
  assert.equal(state.tool, undefined, 'unchanged inspection does not force another result checkpoint');
  state.acted('browser_action', false, { action: 'click' }); state.endTurn();
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
  assert.equal(state.tool, undefined, 'bad formatting releases normal tools instead of stopping the form');
  state.planned();
  state.verified('more_evidence'); assert.equal(state.tool, undefined);
  state.verified('more_evidence'); assert.equal(state.tool, 'record_recovery_plan');
  assert.equal(validToolInput({}, recoveryTools[0].parameters), false);
  assert.equal(validToolInput({ observed_issue: 'Unknown widget', evidence: [], previous_approaches: ['Bad query'],
    next_action: 'Inspect actual controls', verification: 'Observed option saved' }, recoveryTools[0].parameters), false);
});

test('extra evidence and narration preserve the agent decision without executing metadata', () => {
  const input = recoveryInput('record_recovery_result', { assessment: 'progress',
    evidence: Array.from({ length: 6 }, (_, index) => `Observed field ${index}`), next_action: 'Continue',
    verification: 'Extra explanatory narration', browser_action: { action: 'click' } });
  assert.equal(validToolInput(input, recoveryTools[1].parameters), true);
  assert.equal((input.evidence as string[]).length, 6);
  assert.equal('browser_action' in input, false);
  assert.equal(validToolInput(recoveryInput('record_recovery_result', { assessment: 'complete', evidence: ['Visible'] }), recoveryTools[1].parameters), false, 'missing reasoning is never invented');
});

test('repeated successful navigation cycles trigger diagnosis despite different refs', () => {
  const state = new RecoveryCheckpoint();
  const page = (open: boolean, ref: string) => ({ ...observation('', ref), text: open ? 'Editing education' : 'Education overview',
    actions: [{ ref, text: open ? 'Cancel' : 'Next', role: 'button' as const, disabled: false }] });
  state.observe(page(false, 'a1'));
  for (let index = 0; index < 2; index++) {
    state.acted('browser_action', false, { action: 'click', ref: `a${index + 1}` });
    state.observe(page(true, `b${index}`));
    if (!index) {
      state.acted('browser_action', false, { action: 'click', ref: 'b0' });
      state.observe(page(false, 'a2'));
    }
  }
  assert.equal(state.tool, 'record_recovery_plan');
  assert.match(state.render(), /repeated 2 times/);
});

test('intermediate calendar progress needs an agent assessment and cannot fund a revisit', () => {
  const state = new RecoveryCheckpoint();
  state.observe({ ...observation(), surfaceText: 'Calendar 2026' });
  state.acted('browser_action', false, { action: 'click', selector: '[aria-label="Previous year"]' });
  state.observe({ ...observation(), surfaceText: 'Calendar 2016' });
  assert.equal(state.requestBudgetReview(), true);
  state.observe({ ...observation(), surfaceText: 'Calendar 2016' });
  const credit = state.verified('progress');
  assert.equal(typeof credit, 'string', 'format correction / inspection preserves the grounded candidate');
  state.acted('browser_action', false, { action: 'click' });
  state.observe({ ...observation(), surfaceText: 'Calendar 2026' });
  assert.equal(state.verified('progress'), undefined, 'a changed but previously visited state earns no allowance');
  assert.equal(new RecoveryCheckpoint().verified('progress'), undefined, 'narration without actions earns nothing');
});

test('budget review cannot preempt a pending repair with evidence from an earlier action', () => {
  const state = new RecoveryCheckpoint();
  state.observe(observation());
  state.acted('browser_action', false, {action:'fill'}); state.endTurn(); state.observe(observation('Sydney'));
  state.acted('browser_action', true, {action:'click'}); state.endTurn(); state.observe(observation('Sydney'));
  state.acted('browser_action', true, {action:'click'}); state.endTurn(); state.observe(observation('Sydney'));
  assert.equal(state.tool,'record_recovery_plan');
  state.planned({next_action:'Close the optional editor'}); state.endTurn();
  assert.equal(state.requestBudgetReview(),false,'old completed work must not assess an unexecuted plan');
  assert.equal(state.tool,undefined,'normal tools remain available to execute the chosen repair');
  state.acted('browser_batch',false,{actions:[{action:'inspect',selector:'input'}]});state.endTurn();state.observe(observation('Sydney'));
  assert.equal(state.requestBudgetReview(),false,'read-only inspection does not execute the repair');
  assert.equal(state.tool,undefined);
  state.acted('browser_action',false,{action:'click'});state.endTurn();state.observe(observation('Sydney'));
  assert.equal(state.tool,'record_recovery_result','actual repair receives its result check');
  assert.equal(state.verified('no_progress'),undefined,'unchanged repair cannot grant extra spend');
  assert.equal(state.tool,'record_recovery_plan');
});

test('restart journal preserves historical diagnosis and uncertainty without replaying actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'application-recovery-'));
  try {
    const path = join(directory, 'attempt.json');
    const first = new RecoveryCheckpoint(path, 'Submit the selected vacancy');
    first.remember('Education saved; inspect validation before retrying Continue.');
    first.finish('interrupted', true);
    const next = new RecoveryCheckpoint(path);
    assert.match(next.render(), /historical agent claims only/);
    assert.match(next.render(), /Education saved/);
    assert.match(next.render(), /sendAttempted.*true/);
    assert.equal(next.tool, undefined, 'historical operations are never scheduled or replayed');
    assert.equal(next.verified('progress'), undefined, 'old progress does not fund a new attempt');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'interrupted');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delayed rerenders and inspections never execute a newly recorded repair plan', () => {
  const state = new RecoveryCheckpoint();
  state.observe(observation());
  state.planned({ next_action: 'Close optional lookup and complete required language fields' });
  state.endTurn();
  state.observe({ ...observation(), text: 'Lookup finished rendering asynchronously' });
  assert.equal(state.tool, undefined, 'a background render cannot trigger result assessment');
  state.acted('take_snapshot', false); state.endTurn();
  state.observe({ ...observation(), text: 'Another delayed validation message' });
  assert.equal(state.tool, undefined, 'inspection plus async changes still does not execute the plan');
  state.acted('browser_action', false, { action: 'press', value: 'Escape' }); state.endTurn();
  state.observe(observation());
  assert.equal(state.tool, 'record_recovery_result', 'an actual attempted repair still requires checking');
});

test('unrelated rendering cannot erase failures and locator descriptions remain distinct', () => {
 const state = new RecoveryCheckpoint(); state.observe(observation());
 state.acted('browser_action', true, { action: 'click', locator: { by: 'text', value: 'Next', within: 'section' } });
 state.observe({ ...observation(), text: 'Chat animation one' });
 state.acted('browser_action', true, { action: 'click', locator: { by: 'role', value: 'button', name: 'Close', frame: '#chat' } });
 state.observe({ ...observation(), text: 'Chat animation two' });
 assert.equal(state.tool, 'record_recovery_plan');
 assert.match(state.render(), /within/); assert.match(state.render(), /#chat/);
 assert.doesNotMatch(state.render(), /\[object Object\]/);
});
