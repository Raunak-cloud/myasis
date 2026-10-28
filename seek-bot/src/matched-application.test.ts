import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshMatchedApplication } from './matched-application.js';
import { reviewContentFingerprint, reviewContextFingerprint, currentFitReview } from './review-cache.js';
import { config } from './config.js';
import type { CandidateProfile, JobListing } from './types.js';
import type { FitAssessment } from './llm.js';

const profile = { name: 'Fixture', skills: ['TypeScript'], excludedDomains: [] } as unknown as CandidateProfile;
const base: JobListing = { id: 'fixture', title: 'Developer', company: 'Fixture', location: 'Sydney', platform: 'workday', url: 'https://fixture.invalid', description: 'Build web applications.' };
const fit: FitAssessment = { decision: 'apply', shouldApply: true, matchScore: 100, reason: 'Development duties match.', evidence: ['Build web applications.'], injectionSuspected: false };
function approved(job: JobListing): JobListing {
  return { ...job, fitReview: { score: fit.matchScore, reason: fit.reason, evidence: fit.evidence,
    contentFingerprint: reviewContentFingerprint(job)!, contextFingerprint: reviewContextFingerprint(profile) } };
}

test('every employer feed retains an unchanged approval without another model call', async () => {
  for (const platform of ['smartrecruiters', 'greenhouse', 'pageup', 'workday'] as const) {
    const previous = approved({ ...base, platform });
    const result = await refreshMatchedApplication(previous, { ...base, platform, ageDays: 2 }, profile, async () => { throw Error('Unchanged approved facts were reassessed'); });
    assert.ok('job' in result);
    assert.equal(result.job.fitReview, previous.fitReview);
    assert.ok(currentFitReview(result.job, profile));
  }
});

test('changed listing or candidate evidence returns to the matcher before application', async () => {
  const previous = approved(base);
  let calls = 0;
  const changed = { ...base, description: 'Conduct specialist UX research.' };
  const rejected = await refreshMatchedApplication(previous, changed, profile, async job => {
    calls++; assert.equal(job.description, changed.description); assert.equal(job.fitReview, undefined);
    return { ...fit, decision: 'skip', shouldApply: false, reason: 'Primary UX research duties do not match developer experience.' };
  });
  assert.ok('outcome' in rejected); assert.equal(rejected.outcome.status, 'skipped');
  assert.match('reason' in rejected.outcome ? rejected.outcome.reason : '', /Updated matching review/);
  const newProfile = { ...profile, skills: ['TypeScript', 'Python'] };
  const renewed = await refreshMatchedApplication(previous, base, newProfile, async () => { calls++; return fit; });
  assert.ok('job' in renewed); assert.ok(currentFitReview(renewed.job, newProfile));
  assert.equal(calls, 2);
});

test('a refreshed agent decision is authoritative while job identity stays enforced', async () => {
  const previous = approved(base);
  const result = await refreshMatchedApplication(previous, { ...base, description: 'Different duties.' }, profile,
    async () => ({ ...fit, matchScore: Math.max(0, config.rules.minScore - 1) }));
  assert.ok('job' in result, 'a final agent approval is not reclassified using its score');
  await assert.rejects(refreshMatchedApplication(previous, { ...base, id: 'another' }, profile), /different job/);
});
