import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCoverLetter, instructionWordCount, isCoverLetterField, validateCoverLetterInstructions } from './cover-letter-policy.js';

test('cover letter instructions accept 50 words, reject excess words and count Unicode whitespace consistently', () => {
  const fifty = Array.from({ length: 50 }, (_, index) => `word${index}`).join('\u00a0');
  assert.equal(instructionWordCount(fifty), 50);
  assert.equal(validateCoverLetterInstructions(`  ${fifty}  `), fifty);
  assert.equal(validateCoverLetterInstructions(''), '');
  assert.throws(() => validateCoverLetterInstructions(fifty + ' extra'), /50 words/);
  assert.throws(() => validateCoverLetterInstructions('a'.repeat(2001)), /50 words/);
});

test('letter normalization removes em dashes while preserving paragraphs, ordinary hyphens and factual text', () => {
  assert.equal(cleanCoverLetter('Dear team,\r\n\r\nI build full-stack tools — including APIs.\r\n\r\nAlex'), 'Dear team,\n\nI build full-stack tools, including APIs.\n\nAlex');
  assert.equal(isCoverLetterField('Write a cover letter'), true);
  assert.equal(isCoverLetterField('coverLetter'), true);
  assert.equal(isCoverLetterField('Do you have work rights?'), false);
});
