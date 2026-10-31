import assert from 'node:assert/strict';
import { AnswersValidationError, normaliseSavedAnswers, saveAnswers } from './answers.js';

const trading = 'Do you, anyone living with you, or any businesses you or they are involved with trade in publicly listed securities?';
const [saved] = normaliseSavedAnswers([{ question: 'This info is required. (7 out of 20 issues)', prompt: trading, answer: 'No' }]);
assert.deepEqual(saved, { question: trading, answer: 'No' }, 'A validation message must not become the saved fact context');

const changedLabel = normaliseSavedAnswers([{ question: 'This info is required. (1 out of 8 issues)', prompt: trading, answer: 'No' }]);
assert.deepEqual(changedLabel[0], saved, 'Changing error numbering must not change the meaning of a saved answer');

const differentQuestions = normaliseSavedAnswers([
  { question: 'This info is required.', prompt: trading, answer: 'No' },
  { question: 'This info is required.', prompt: 'Are you legally entitled to work in Australia?', answer: 'Yes' },
]);
assert.equal(new Map(differentQuestions.map(item => [item.question, item.answer])).size, 2, 'Identical validation captions must not mix unrelated answers');

assert.deepEqual(normaliseSavedAnswers([{ question: ' Country of birth? ', answer: ' Nepal ' }]), [{ question: 'Country of birth?', answer: 'Nepal' }], 'Existing clients without prompt metadata retain their actual question');
assert.deepEqual(normaliseSavedAnswers([{ question: 'Country of birth?', prompt: '  ', answer: 'Nepal' }]), [{ question: 'Country of birth?', answer: 'Nepal' }]);
assert.deepEqual(normaliseSavedAnswers([{ question: '', prompt: '', answer: 'No' }, { question: trading, answer: '  ' }]), []);
for (const input of [null, {}, 'Question', [null], [{ question: {}, answer: 'Yes' }], [{ question: 'Question', answer: {} }], [{ question: 'Question', answer: true }], [{ question: 'Question', answer: ['Yes'] }], [{ question: 'Question', prompt: 1, answer: 'Yes' }]]) {
  assert.deepEqual(normaliseSavedAnswers(input), [], 'Malformed candidate facts must never be converted to text');
  await assert.rejects(saveAnswers('fixture-owner', input), AnswersValidationError, 'Invalid input must fail before opening a database connection');
}
for (const answers of [[], [{ question: '*', answer: 'Yes' }], [{ question: 'Password', answer: 'secret' }], [{ question: 'More information', prompt: 'What is your password?', answer: 'secret' }], [{ question: 'Question', answer: 'a'.repeat(4001) }], [{ question: 'q'.repeat(501), answer: 'Yes' }], [{ question: 'Question', answer: 'Yes' }, { question: 'Question', answer: 'No' }]]) {
  await assert.rejects(saveAnswers('fixture-owner', answers), AnswersValidationError);
}
await assert.rejects(saveAnswers('fixture-owner', [{ question: 'Question', answer: 'Yes' }], ''), AnswersValidationError);
assert.deepEqual(normaliseSavedAnswers([{ question: ' Available weekends? * ', answer: 'Yes' }]), [{ question: 'Available weekends?', answer: 'Yes' }]);
console.log('PASS: saved-answer context and malformed-payload regressions');
