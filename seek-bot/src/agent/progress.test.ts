import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationProgress } from './progress.js';
import type { Observation } from './observe.js';

const observation = (): Observation => ({ url: 'https://fixture.invalid', title: 'Job', text: 'Application', actions: [],
  fields: [{ ref: 'f0', label: 'City', kind: 'text', required: true, autocomplete: true, currentValue: '' }] });

test('two unchanged action turns prompt recovery; inspections are neutral and real progress resets it', () => {
  const progress = new ApplicationProgress();
  const state = observation();
  assert.equal(progress.inspect(state), undefined);
  progress.attemptedAction('fill_fields');
  assert.equal(progress.inspect(state), undefined);
  progress.attemptedAction('fill_fields');
  const renumbered = { ...state, title: 'Changed tab title', fields: state.fields.map(field => ({ ...field, ref: 'f9' })) };
  assert.match(progress.inspect(renumbered)!, /No visible progress after 2.*fill_fields/);
  assert.equal(progress.inspect(state), undefined, 'inspection is not another failed mutation');
  progress.attemptedAction('fill_fields');
  assert.match(progress.inspect(state)!, /No visible progress after 3/, 'an inspection cannot hide a repeated failed action');
  progress.attemptedAction('browser_action/fill');
  assert.equal(progress.inspect({ ...state, fields: [{ ...state.fields[0], currentValue: 'Sydney' }] }), undefined);
  progress.attemptedAction('browser_action/click');
  assert.equal(progress.inspect({ ...state, actions: [{ ref: 'a0', text: 'Sydney NSW', role: 'option', disabled: false }] }), undefined, 'opening a widget is progress');
});
