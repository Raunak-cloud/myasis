import assert from 'node:assert/strict';
import { outcomeFromRun } from './outcome.js';

type Run = Parameters<typeof outcomeFromRun>[0];
const run = (outcome: Run['outcome'], submitPressed: boolean): Run => ({
  outcome, submitPressed, captured: [], actions: [], steps: 3, usage: '',
});

// Every board's outcome carries the submit flag, so no board can retry a sent form.
const skipped = outcomeFromRun(run({ status: 'skipped', reason: 'page did not change' }, true), 'job-1', 'https://employer.example/apply');
assert.equal(skipped.status, 'skipped');
assert.equal(skipped.submitPressed, true);
assert.equal(outcomeFromRun(run({ status: 'skipped', reason: 'x' }, false), 'job-1', '').submitPressed, undefined);
const rejection = outcomeFromRun(run({ status: 'skipped', reason: 'Location mismatch', fitRejection: { source: 'listing', evidence: 'Melbourne VIC' } }, false), 'job-1', '');
assert.ok(rejection.status === 'skipped' && rejection.fitRejection?.source === 'listing');

const frictions: string[] = [];
const blocked = outcomeFromRun(run({ status: 'needs-human', reason: 'CapMonster could not clear the CAPTCHA' }, false), 'job-2', 'https://x.example', (kind) => frictions.push(kind));
assert.equal(blocked.status, 'skipped', 'a technical wall without a question is not a candidate task');
assert.deepEqual(frictions, ['captcha'], 'walls still feed the run-level friction counter');

for (const reason of ['Fundamental field mismatch: insurance instead of software', 'Major role mismatch: sales programme', 'Physical data centre work is outside saved preferences']) {
  const mismatch = outcomeFromRun(run({ status: 'needs-human', reason }, false), 'mismatch', 'https://employer.example/apply');
  assert.equal(mismatch.status, 'skipped');
  assert.equal(mismatch.reason, reason);
}
const question = { question: 'Current clearance *', prompt: 'Which clearance do you currently hold?', kind: 'select' as const, options: ['None', 'Baseline'] };
const attention = outcomeFromRun(run({ status: 'needs-human', reason: 'Current clearance is unknown', questions: [question] }, false), 'question', 'https://employer.example/apply');
assert.equal(attention.status, 'needs-human');
assert.ok(attention.status === 'needs-human' && attention.questions?.[0].question === 'Current clearance');
assert.ok(attention.status === 'needs-human' && attention.questions?.[0].prompt === question.prompt);
assert.ok(attention.status === 'needs-human' && attention.url === 'https://employer.example/apply');
assert.equal(outcomeFromRun(run({ status: 'needs-human', reason: 'No usable question', questions: [{ question: '  ' }, { question: 'Password' }] }, true), 'empty', '').status, 'skipped');
assert.equal(outcomeFromRun(run({ status: 'needs-human', reason: 'No usable question' }, true), 'empty', '').submitPressed, true, 'uncertain sends keep their duplicate protection');

const applied = outcomeFromRun({ ...run({ status: 'applied' }, true), site: 'careers.example.com', applicationUrl: 'https://careers.example.com/jobs/3', coverLetter: 'Dear team' }, 'job-3', '');
assert.ok(applied.status === 'applied' && applied.site === 'careers.example.com' && applied.coverLetter === 'Dear team');
assert.equal(applied.applicationUrl, 'https://careers.example.com/jobs/3');
console.log('agent outcome mapping checks passed');
