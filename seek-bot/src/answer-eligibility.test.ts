import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitingForCurrentAnswers } from './answer-eligibility.js';
import { withApplicationModel } from './application-model.js';
import { sealQuestionSnapshot } from './question-snapshot-node.js';
import type { JobListing } from './types.js';

test('current owner, exact question revision and changed answers determine eligibility afresh', () => {
  const root = mkdtempSync(join(tmpdir(), 'owtomate-answer-eligibility-'));
  const a = join(root, 'owner-a'), b = join(root, 'owner-b'); mkdirSync(a); mkdirSync(b);
  const job: JobListing = { id: 'same-job', platform: 'seek', title: 'Fixture analyst', company: 'Fixture employer', location: 'Sydney', url: 'https://www.seek.com.au/job/12345678' };
  const capture = (labels = ['Yes', 'No']) => sealQuestionSnapshot({ version: 2, source: { origin: 'https://employer.fixture.invalid', path: '' },
    prompt: 'Do you hold the required licence?', context: [], help: [], completeness: 'complete', controls: [{ id: 'part0', label: 'Do you hold the required licence?',
      kind: 'radio', multiple: false, required: true, choices: labels.map((label, index) => ({ id: `choice${index}`, label, value: label, disabled: false })), constraints: {} }] });
  const original = capture();
  const pending = (directory: string, snapshot = original, url = job.url) => writeFileSync(join(directory, 'attention.json'), JSON.stringify({ asOf: new Date().toISOString(),
    items: [{ jobId: job.id, title: job.title, company: job.company, url, at: new Date().toISOString(), reason: 'Required candidate fact is unknown.', questions: [{ question: snapshot.prompt, snapshot }] }] }));
  const answer = (directory: string) => writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: original.prompt, answer: 'No', snapshot: original, response: { part0: 'choice1' } }]));
  const inside = (directory: string, value = job) => withApplicationModel({ ...process.env, DATA_DIR: directory }, () => waitingForCurrentAnswers(value));
  try {
    pending(a); pending(b); answer(b);
    assert.equal(inside(a), true); assert.equal(inside(b), false); assert.equal(inside(a), true, 'another owner response never releases this owner task');
    assert.equal(withApplicationModel({...process.env,DATA_DIR:a},()=>waitingForCurrentAnswers(job,'preparation')),false,'unanswered form questions do not block a job-and-letter draft');
    assert.equal(inside(a),true,'preparation does not resolve or bypass questions when the job is actually applied to');
    answer(a); assert.equal(inside(a), false, 'changed structured answer is read even when the pending snapshot file is unchanged');
    pending(a, capture(['Yes', 'No', 'Other'])); assert.equal(inside(a), true, 'a changed current revision cannot use the old response');
    const customRequired = sealQuestionSnapshot({ ...original, controls: original.controls.map(control => ({ ...control, required: false })) });
    pending(a, customRequired); assert.equal(inside(a), true, 'current pending state remains authoritative without native required markup');
    writeFileSync(join(a, 'answers.json'), JSON.stringify([{ question: customRequired.prompt, answer: 'No', snapshot: customRequired, response: { part0: 'choice1' } }]));
    assert.equal(inside(a), false, 'an exact valid structured answer also releases a custom-required task');
    writeFileSync(join(a, 'attention.json'), JSON.stringify({ asOf: new Date().toISOString(), items: [] }));
    assert.equal(inside(a), false, 'resolved current state is not cached as a permanent veto');
    const external = { ...job, platform: 'workday' as const, url: 'https://careers.fixture.invalid/job/role-one/apply' };
    pending(a, original, external.url);
    writeFileSync(join(a, 'answers.json'), '[]');
    assert.equal(inside(a, external), true);
    assert.equal(inside(a, { ...external, url: 'https://careers.fixture.invalid/job/role-two/apply' }), false, 'same employer/title/ID cannot block a distinct exact external form');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
