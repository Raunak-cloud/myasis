import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFormExpectations } from './form-replay-compare.js';
import type { FormExpectation } from './form-corpus.js';

const field = (label: string, kind = 'text', required = true) => ({ label, kind, required, options: 0 });
const snapshot = (fields: FormExpectation['fields']): FormExpectation => ({
  url: 'https://fixture.invalid/apply', host: 'fixture.invalid', platform: 'Fixture',
  capturedAt: '', fields, actions: [], coverLetterOffered: true, captcha: false,
});
const regressions = (before: FormExpectation, now: FormExpectation) =>
  compareFormExpectations('fixture', before, now).filter(finding => finding.kind === 'regression');

test('reordering distinct questions and duplicate labels preserves field identities', () => {
  const fields = [field('Name'), field('Access requirements', 'textarea', false), field('Country'), field('Name', 'textarea')];
  assert.deepEqual(regressions(snapshot(fields), snapshot([...fields].reverse())), []);
});

test('an inserted field does not turn later fields into false type regressions', () => {
  const fields = [field('Name'), field('Access requirements', 'textarea')];
  assert.deepEqual(regressions(snapshot(fields), snapshot([field('New question', 'select'), ...fields])), []);
});

test('a real type change is still a regression after reordering', () => {
  const before = snapshot([field('Name'), field('Access requirements', 'textarea')]);
  assert.match(regressions(before, snapshot([field('Access requirements'), field('Name')]))[0].detail, /kind: textarea/);
});

test('missing fields, duplicate occurrences and meaningful labels remain protected', () => {
  const before = snapshot([field('Name'), field('Name')]);
  assert.ok(regressions(before, snapshot([field('Name')])).some(finding => /fields found/.test(finding.detail)));
  assert.ok(regressions(snapshot([field('Name')]), snapshot([field('unlabelled field')])).some(finding => /lost its label/.test(finding.detail)));
});

test('required status, security surfaces and cover letter opportunities remain protected', () => {
  const before = snapshot([field('Name')]);
  assert.ok(regressions(before, snapshot([field('Name', 'text', false)])).some(finding => /required status/.test(finding.detail)));
  assert.ok(regressions(before, { ...before, captcha: true }).some(finding => /security check/.test(finding.detail)));
  assert.ok(regressions(before, { ...before, coverLetterOffered: false }).some(finding => /cover letter/.test(finding.detail)));
});
