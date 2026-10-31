import assert from 'node:assert/strict';
import { blockedQuestionKey, normaliseAttentionOutcome, normaliseBlockedQuestions } from './blocked-questions.js';

assert.deepEqual(normaliseBlockedQuestions([null, true, [], { question: {} }, { question: 'Password' }, { question: 'More information', prompt: 'What is your password?' }]), []);
const contexts = normaliseBlockedQuestions([
  { question: 'Tell us more *', prompt: 'What is your notice period?', options: [' Now ', null, {}, 1, 'Now', 'Later'] },
  { question: 'Tell us more', prompt: 'Why do you want this role?' },
  { question: 'Tell us more', prompt: 'What is your notice period?' },
]);
assert.equal(contexts.length, 2, 'Repeated captions with different prompts remain distinct; the same context is deduplicated');
assert.deepEqual(contexts[0].options, ['Now', 'Later'], 'Only actual string choices reach the candidate');
assert.equal(blockedQuestionKey({ question: ' A label * ', prompt: ' Full   question? ' }), 'Full question?');
assert.equal(blockedQuestionKey({ question: 'A label', prompt: ' Current clearance * ' }), 'Current clearance');
assert.equal(blockedQuestionKey({ question: ' Current clearance * * ', prompt: ' ' }), 'Current clearance');
assert.equal(blockedQuestionKey({ question: 'Current clearance', prompt: 'Current clearance' }), blockedQuestionKey({ question: 'Current clearance *', prompt: 'Current clearance *' }));
const marked = normaliseBlockedQuestions([{ question: 'Current clearance *', prompt: 'Current clearance *' }]);
assert.equal(marked[0].prompt, 'Current clearance *', 'canonical matching must retain the actual displayed employer copy');
const outcome = normaliseAttentionOutcome({ status: 'needs-human', jobId: 'fixture', url: 'https://example.test', reason: 'No usable question', questions: [{ question: 'Password' }], applicationUrl: 'https://employer.test/apply', submitPressed: true });
assert.equal(outcome.status, 'skipped');
assert.equal(outcome.submitPressed, true);
assert.equal(outcome.applicationUrl, 'https://employer.test/apply', 'A malformed blocker still retains the application entry and duplicate protection');
console.log('PASS: blocked-question payload/context regressions');
