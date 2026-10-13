import assert from 'node:assert/strict';
import { normaliseSavedAnswers } from './answers.js';

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
console.log('PASS: six saved-answer context regressions');
