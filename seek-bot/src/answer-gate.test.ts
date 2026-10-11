import assert from 'node:assert/strict';
import test from 'node:test';
import { answerKey, waitingForAnswers } from './answer-gate.js';

const stopped = '2026-10-10T10:00:00.000Z';
const before = Date.parse('2026-10-10T09:00:00.000Z');
const after = Date.parse('2026-10-10T11:00:00.000Z');
const blocked = { at: stopped, status: 'needs-human', questions: [{ question: 'Do you hold a  White Card?' }] };

test('a job stopped on an unanswered question waits', () => {
  assert.equal(waitingForAnswers(blocked, new Map()), true);
  assert.equal(waitingForAnswers(blocked, new Map([[answerKey('Do you hold a White Card?'), before]])), true);
});

test('an answer saved after the stop lets it through, whatever its spacing or case', () => {
  assert.equal(waitingForAnswers(blocked, new Map([[answerKey('do you hold a white card?'), after]])), false);
});

test('a stop with no questions is retried as before', () => {
  assert.equal(waitingForAnswers({ at: stopped, status: 'needs-human' }, new Map()), false);
  assert.equal(waitingForAnswers({ at: stopped, status: 'needs-human', questions: [] }, new Map()), false);
});

test('a record that cannot say fails open', () => {
  assert.equal(waitingForAnswers(blocked, null), false);
  assert.equal(waitingForAnswers({ ...blocked, at: 'not a date' }, new Map()), false);
  assert.equal(waitingForAnswers(undefined, new Map()), false);
  assert.equal(waitingForAnswers({ ...blocked, status: 'skipped' }, new Map()), false);
});
