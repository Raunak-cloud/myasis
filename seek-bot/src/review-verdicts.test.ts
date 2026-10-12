import assert from 'node:assert/strict';
import test from 'node:test';
import { chosenListings, verdictContext, type ReviewVerdict } from './review-verdicts.js';

const base = { title: 'Junior Developer', company: 'Acme', skipReason: 'The role asks for 5+ years.', at: '2026-10-12T00:00:00.000Z' };

test('a job the candidate would have applied to comes back as their choice, on its own board', () => {
  const verdicts: ReviewVerdict[] = [
    { ...base, jobId: '94000001', url: 'https://www.seek.com.au/job/94000001', verdict: 'apply' },
    { ...base, jobId: 'abcdef0123456789', url: 'https://au.indeed.com/viewjob?jk=abcdef0123456789', verdict: 'apply' },
    { ...base, jobId: '94000002', url: 'https://www.seek.com.au/job/94000002', verdict: 'skip' },
    { ...base, jobId: '94000003', verdict: 'apply' },
    { ...base, jobId: 'x', url: 'https://careers.example.com/job/1', verdict: 'apply' },
  ];
  const chosen = chosenListings(verdicts);
  assert.deepEqual(chosen.map((job) => [job.id, job.platform, job.source]), [
    ['94000001', 'seek', 'chosen'],
    ['abcdef0123456789', 'indeed', 'chosen'],
  ]);
});

test('every call becomes calibration context, framed as never overriding instructions', () => {
  assert.equal(verdictContext([]), '');
  const block = verdictContext([
    { ...base, jobId: '1', verdict: 'apply', note: '4 years is close enough' },
    { ...base, jobId: '2', title: 'Recruitment Agency Role', verdict: 'skip' },
  ]);
  assert.match(block, /Junior Developer" at Acme\. Skipped because: The role asks for 5\+ years\. The candidate would have applied\. In their words: "4 years is close enough"/);
  assert.match(block, /Recruitment Agency Role" at Acme.*agreed it was right to skip/);
  assert.match(block, /never overrides the candidate's instructions/);
});
