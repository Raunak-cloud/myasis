import { plainReason, resolveAttention, type RunEventRow } from './attention.js';
import { normaliseAttentionOutcome } from '../../seek-bot/src/blocked-questions.js';
import { normaliseSavedAnswers } from './answers.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const event = (status: string, minute: number, questions: unknown[] = []): RunEventRow => ({
  job_id: 'job-1',
  status,
  title: 'Example role',
  company: 'Example employer',
  reason: status,
  url: 'https://example.test/job-1',
  ts: `2026-09-12T10:${String(minute).padStart(2, '0')}:00.000Z`,
  questions,
});

check(
  'a later resolved event clears an older blocker',
  resolveAttention([event('needs-human', 1, ['Required answer']), event('already-applied', 2)], new Set()).length === 0,
);
check(
  'a later critical question remains visible',
  resolveAttention([event('skipped', 1), event('needs-human', 2, ['Required answer'])], new Set()).length === 1,
);
for (const status of ['skipped', 'error', 'off-platform', 'needs-human']) {
  check(`a later ${status} without answers preserves the unresolved candidate question`,
    resolveAttention([event('needs-human', 1, ['Street address']), event(status, 2)], new Set())[0]?.questions?.[0]?.question === 'Street address');
}
for (const status of ['answered', 'prepared', 'rehearsed', 'applied']) {
  check(`a later ${status} resolves the candidate question`,
    resolveAttention([event('needs-human', 1, ['Street address']), event(status, 2)], new Set()).length === 0);
}
check(
  'an application record clears all blockers for that job',
  resolveAttention([event('needs-human', 1, ['Required answer'])], new Set(['job-1'])).length === 0,
);
check(
  'technical needs-human events do not ask the candidate to intervene',
  resolveAttention([event('needs-human', 1)], new Set()).length === 0,
);
check(
  'errors and off-platform outcomes do not enter Needs attention',
  resolveAttention([event('error', 1), event('off-platform', 2)], new Set()).length === 0,
);
check(
  'internal browser field refs never reach user-facing reasons',
  plainReason('The mandatory street address field (f7) is not in the candidate profile.') ===
    'The mandatory street address field is not in the candidate profile.',
);

const prompted = resolveAttention([
  event('needs-human', 1, [{
    question: 'Tell us more',
    prompt: 'Describe yourself and explain why you are interested in this role.',
    kind: 'textarea',
  }]),
], new Set());
check(
  'candidate-facing prompts survive attention normalisation',
  prompted[0]?.questions?.[0]?.prompt === 'Describe yourself and explain why you are interested in this role.',
);

const candidateQuestion = normaliseAttentionOutcome({ status: 'needs-human', jobId: 'job-1', reason: 'Current clearance is unknown', url: 'https://example.test/job-1', questions: [{ question: 'Current clearance *', prompt: 'Which clearance do you currently hold?', kind: 'select', options: ['None', 'Baseline'] }] });
const savedAttention = resolveAttention([{ ...event(candidateQuestion.status, 3), reason: candidateQuestion.status === 'needs-human' ? candidateQuestion.reason : '', questions: candidateQuestion.status === 'needs-human' ? candidateQuestion.questions ?? [] : [] }], new Set());
check('a normalised run question survives the database-to-attention lifecycle with its choices',
  savedAttention[0]?.questions?.[0]?.question === 'Current clearance' && savedAttention[0]?.questions?.[0]?.options?.join(',') === 'None,Baseline');
check('role mismatches without questions stay out of Needs attention',
  resolveAttention([{ ...event('needs-human', 4), reason: 'Fundamental field mismatch', questions: [] }], new Set()).length === 0);

const reusedLabels = [{ question: 'Tell us more', prompt: 'What is your notice period?' }, { question: 'Tell us more', prompt: 'Why do you want this role?' }];
const partial = resolveAttention([event('needs-human', 1, reusedLabels), event('answered', 2, [{ question: reusedLabels[0].prompt }])], new Set());
check('a fact-specific answer removes only its exact context from a delayed group', partial[0]?.questions?.length === 1 && partial[0]?.questions?.[0]?.prompt === reusedLabels[1].prompt);
check('a stale label-only answer cannot resolve a different full prompt', resolveAttention([event('needs-human', 1, reusedLabels), event('answered', 2, [{ question: 'Tell us more' }])], new Set())[0]?.questions?.length === 2);
check('answering both contexts resolves the group', resolveAttention([event('needs-human', 1, reusedLabels), event('answered', 2, reusedLabels.map(question => ({ question: question.prompt })))], new Set()).length === 0);
const requiredMarker = { question: 'Current clearance', prompt: 'Current clearance *' };
const requiredAnswer = normaliseSavedAnswers([{ ...requiredMarker, answer: 'None' }])[0];
check('required markers do not change a saved question context during lifecycle normalization', resolveAttention([
  event('needs-human', 1, [requiredMarker]), event('answered', 2, [{ question: requiredAnswer.question }]),
], new Set()).length === 0);
check('a genuinely later recurrence still requires its answer', resolveAttention([event('answered', 1, [{ question: 'Street address' }]), event('needs-human', 2, ['Street address'])], new Set()).length === 1);
for (const questions of [[null], [{ question: 'Password' }], [{ question: 'More information', prompt: 'Enter your password' }], [{ question: {} }]]) {
  check('invalid later question metadata cannot hide an existing task', resolveAttention([event('needs-human', 1, ['Street address']), event('needs-human', 2, questions)], new Set())[0]?.questions?.[0]?.question === 'Street address');
}
const dismissed = { ...event('needs-human', 1, ['Street address']), dismissed_at: '2026-09-12T10:03:00.000Z' };
check('dismissal covers a delayed import from before it was cleared', resolveAttention([dismissed, event('needs-human', 2, ['Street address'])], new Set()).length === 0);
check('a new run after dismissal can recur', resolveAttention([dismissed, event('needs-human', 4, ['New required question'])], new Set())[0]?.questions?.[0]?.question === 'New required question');
check('same-timestamp events use database identity order', resolveAttention([{ ...event('answered', 2), id: '12' }, { ...event('needs-human', 2, ['Street address']), id: '11' }], new Set()).length === 0);
check('Date timestamps keep their millisecond ordering', resolveAttention([{ ...event('answered', 2), ts: new Date('2026-09-12T10:02:00.002Z') }, { ...event('needs-human', 2, ['Street address']), ts: new Date('2026-09-12T10:02:00.001Z') }], new Set()).length === 0);
check('PostgreSQL microsecond ordering wins over import identity within a millisecond', resolveAttention([
  { ...event('answered', 2, [{ question: 'Street address' }]), id: '11', order_at: '1789207320000800' },
  { ...event('needs-human', 2, ['Street address']), id: '12', order_at: '1789207320000100' },
], new Set()).length === 0);
check('invalid timestamps are ignored safely', resolveAttention([{ ...event('needs-human', 2, ['Street address']), ts: 'not-a-date' }], new Set()).length === 0);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
