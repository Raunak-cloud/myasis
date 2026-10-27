import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressBudget, ProgressStepBudget } from './progress-budget.js';
import type { FormField } from '../types.js';

const field = (label: string, value = '', extra: Partial<FormField> = {}): FormField => ({ ref: 'fresh-ref', label, kind: 'text', required: true, currentValue: value, ...extra });
const spend = (meter: ProgressBudget, amountUsd: number) => meter.recordProvider({ prompt: 0, cached: 0, completion: 0, amountUsd });

test('unchanged pages and passive prefills keep the normal twenty-cent budget', () => {
  const meter = new ProgressBudget(0.20);
  meter.observe([field('Name')], false);
  spend(meter, 0.19);
  meter.observe([field('Name')], true);
  meter.observe([field('Name', 'Saved by page')], false);
  assert.equal(meter.limitUsd, 0.20);
  spend(meter, 0.01);
  assert.equal(meter.exhausted, true);
});

test('recent new answers extend spending gradually up to fifty cents', () => {
  const meter = new ProgressBudget(0.20);
  const fields = [field('Name'), field('Email'), field('Phone'), field('Letter')];
  meter.observe(fields, false);
  spend(meter, 0.15);
  fields[0].currentValue = 'Candidate'; meter.observe(fields, true);
  assert.equal(meter.limitUsd, 0.25);
  spend(meter, 0.09);
  fields[1].currentValue = 'fixture@example.invalid'; meter.observe(fields, true);
  assert.ok(Math.abs(meter.limitUsd - 0.34) < 1e-9);
  spend(meter, 0.09);
  fields[2].currentValue = '0400000000'; meter.observe(fields, true);
  assert.ok(Math.abs(meter.limitUsd - 0.43) < 1e-9);
  spend(meter, 0.09);
  fields[3].currentValue = 'Dear team'; meter.observe(fields, true);
  assert.equal(meter.limitUsd, 0.50);
  spend(meter, 0.08);
  assert.equal(meter.exhausted, true);
});

test('early progress, rewriting, clearing/refilling and ref churn cannot renew extra spending', () => {
  const meter = new ProgressBudget(0.20);
  meter.observe([field('Name')], false);
  spend(meter, 0.02);
  meter.observe([field('Name', 'First')], true);
  spend(meter, 0.17);
  meter.observe([field('Name', '', { ref: 'different-ref' })], true);
  meter.observe([field('Name', 'Changed')], true);
  assert.equal(meter.limitUsd, 0.20);
  spend(meter, 0.02);
  assert.equal(meter.exhausted, true);
});

test('invalid fields and private credentials do not earn spending; an actual repair does once', () => {
  const meter = new ProgressBudget(0.20);
  meter.observe([field('Email'), field('Password', '', { sensitive: true })], false);
  spend(meter, 0.18);
  meter.observe([field('Email', 'invalid', { validationError: 'Invalid email' }), field('Password', 'secret', { sensitive: true })], true);
  assert.equal(meter.limitUsd, 0.20);
  meter.observe([field('Email', 'valid@example.invalid')], true);
  assert.equal(meter.limitUsd, 0.28);
  spend(meter, 0.09);
  meter.observe([field('Email', 'bad', { validationError: 'Invalid email' })], true);
  meter.observe([field('Email', 'valid@example.invalid')], true);
  assert.equal(meter.limitUsd, 0.28);
});

test('a new form step counts once, revisiting steps and uploads cannot repeatedly renew', () => {
  const meter = new ProgressBudget(0.20);
  meter.observe([field('Name')], false);
  spend(meter, 0.18);
  meter.observe([field('Availability')], true);
  assert.equal(meter.limitUsd, 0.28);
  spend(meter, 0.09);
  meter.observe([field('Name')], true);
  meter.observe([field('Availability')], true);
  assert.equal(meter.limitUsd, 0.28);
  meter.uploaded('resume-1');
  assert.equal(meter.limitUsd, 0.37);
  spend(meter, 0.09);
  meter.uploaded('resume-1');
  assert.equal(meter.limitUsd, 0.37);
});

test('invalid operator settings retain safe finite budget defaults', () => {
  const meter = new ProgressBudget(Number.NaN, Number.POSITIVE_INFINITY);
  assert.equal(meter.limitUsd, 0.20);
  assert.equal(meter.maximum, 0.50);
  spend(meter, 0.20);
  assert.equal(meter.exhausted, true);
});

test('only newly verified work increments progress, not prefills, rewrites or repeated uploads', () => {
  const meter = new ProgressBudget(0.20);
  meter.observe([field('Name', 'Prefilled'), field('Email')], false);
  assert.equal(meter.progressCount, 0);
  meter.observe([field('Name', 'Rewritten'), field('Email', 'passive@example.invalid')], false);
  meter.observe([field('Name', 'Rewritten'), field('Email', '')], true);
  meter.observe([field('Name', 'Rewritten'), field('Email', 'again@example.invalid')], true);
  assert.equal(meter.progressCount, 0, 'passive and previously completed fields cannot become fresh progress');
  meter.observe([field('Availability')], true);
  assert.equal(meter.progressCount, 1, 'a genuinely new wizard stage counts');
  meter.uploaded('cv'); meter.uploaded('cv');
  assert.equal(meter.progressCount, 2);
});

test('a stuck form or old early progress cannot extend sixty turns', () => {
  const stuck = new ProgressStepBudget(60);
  for (let turn = 0; turn < 60; turn++) assert.equal(stuck.permits(turn, 0), true);
  assert.equal(stuck.permits(60, 0), false);
  const early = new ProgressStepBudget(60);
  for (let turn = 0; turn < 60; turn++) early.permits(turn, turn ? 1 : 0);
  assert.equal(early.permits(60, 1), false);
});

test('recent progress renews twenty turns, needs new evidence each window and never exceeds 120', () => {
  const turns = new ProgressStepBudget(60);
  let progress = 0;
  for (let turn = 0; turn <= 120; turn++) {
    if ([58, 78, 98, 118].includes(turn)) progress++;
    assert.equal(turns.permits(turn, progress), turn < 120, `turn ${turn}`);
  }
  const oneSuccess = new ProgressStepBudget(60);
  for (let turn = 0; turn < 80; turn++) assert.equal(oneSuccess.permits(turn, turn >= 58 ? 1 : 0), true);
  assert.equal(oneSuccess.permits(80, 1), false, 'notes, repeated actions and snapshots provide no new progress');
});

test('operator caps and invalid step settings remain bounded', () => {
  const lower = new ProgressStepBudget(60, 30);
  for (let turn = 0; turn < 30; turn++) assert.equal(lower.permits(turn, turn), true);
  assert.equal(lower.permits(30, 30), false);
  const high = new ProgressStepBudget(1000, 1000);
  assert.equal(high.maximum, 120);
  assert.equal(high.permits(120, 120), false);
  assert.equal(new ProgressStepBudget(NaN, Infinity).maximum, 120);
});
