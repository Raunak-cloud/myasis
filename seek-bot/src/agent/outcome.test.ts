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

const frictions: string[] = [];
const blocked = outcomeFromRun(run({ status: 'needs-human', reason: 'CapMonster could not clear the CAPTCHA' }, false), 'job-2', 'https://x.example', (kind) => frictions.push(kind));
assert.equal(blocked.status, 'needs-human');
assert.deepEqual(frictions, ['captcha'], 'walls still feed the run-level friction counter');

const applied = outcomeFromRun({ ...run({ status: 'applied' }, true), site: 'careers.example.com', coverLetter: 'Dear team' }, 'job-3', '');
assert.ok(applied.status === 'applied' && applied.site === 'careers.example.com' && applied.coverLetter === 'Dear team');
console.log('agent outcome mapping checks passed');
