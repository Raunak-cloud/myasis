import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withApplicationModel } from './application-model.js';
import { reviewContentFingerprint, reviewContextFingerprint, currentFitReview } from './review-cache.js';
import { priorDirectApproval } from './direct-retry-approval.js';
import { refreshMatchedApplication } from './matched-application.js';
import { reviewDuplicate } from './duplicate-review.js';
import type { CandidateProfile, JobListing, AppliedRecord } from './types.js';

test('exact unsent employer retry reuses approval only for unchanged vacancy and candidate context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-retry-'));
  try { await withApplicationModel({ DATA_DIR: directory }, async () => {
    mkdirSync(join(directory, 'traces'));
    const profile = { name: 'Alex Fixture', email: 'fixture@example.invalid', skills: ['Analytics'] } as CandidateProfile;
    const base: JobListing = { id: 'original-matched-job', platform: 'greenhouse', title: 'Commercial Analyst', company: 'Fixture', location: 'Sydney', url: 'https://job-boards.greenhouse.io/fixture/jobs/12345', applicationMode: 'external', source: 'search', description: 'Analyse customer data and build Power BI reports.', workArrangement: 'hybrid' };
    const previous: JobListing = { ...base, fitReview: { score: 82, reason: 'Approved analytics work.', evidence: ['Analyse customer data.'], contentFingerprint: reviewContentFingerprint(base)!, contextFingerprint: reviewContextFingerprint(profile) } };
    const direct: JobListing = { ...base, id: 'new-direct-id', platform: 'external', applicationUrl: base.url, location: 'Sydney Australia', workArrangement: undefined };
    const path = join(directory, 'traces', `attempt-${randomUUID()}.json`);
    const trace = { job: previous, outcome: { status: 'error', retryable: true }, sendAudit: { attempted: false }, steps: [{ args: { action: 'fill' } }] };
    writeFileSync(path, JSON.stringify(trace));
    let refreshes = 0;
    const refresh = async () => { refreshes++; return { ...base }; };
    const reused = await priorDirectApproval(direct, profile, refresh);
    assert.equal(reused?.id, previous.id); assert.equal(reused?.platform, previous.platform);
    assert.equal(reused?.fitReview?.score, 82); assert.ok(currentFitReview(reused!, profile));
    const reviewed = await refreshMatchedApplication(reused!, reused!, profile, async () => { throw Error('The unchanged saved approval must not be reassessed'); });
    assert.ok('job' in reviewed);
    assert.equal(await priorDirectApproval(direct, { ...profile, skills: ['Different skills'] }, refresh), undefined);
    assert.equal(refreshes, 1, 'changed candidate context cannot even start approval reuse');
    for (const changed of [{ ...base, description: 'Perform a different occupation.' }, { ...base, location: 'Melbourne' }, { ...base, id: 'different-posting' }]) assert.equal(await priorDirectApproval(direct, profile, async () => changed), undefined);
    for (const changed of [{ ...direct, url: base.url + '?jobId=other' }, { ...direct, applicationUrl: 'https://job-boards.greenhouse.io/fixture/jobs/9999' }, { ...direct, company: 'Another employer' }]) assert.equal(await priorDirectApproval(changed, profile, refresh), undefined);
    for (const change of [{ sendAudit: { attempted: true } }, { sendAudit: {} }, { steps: [{ args: { sends_application: true } }] }, { steps: [{ args: { actions: [{ sends_application: true }] } }] }, { outcome: { status: 'applied' } }]) {
      writeFileSync(path, JSON.stringify({ ...trace, ...change }));
      assert.equal(await priorDirectApproval(direct, profile, refresh), undefined);
    }
    writeFileSync(path, JSON.stringify(trace));
    const other = mkdtempSync(join(tmpdir(), 'other-retry-owner-'));
    try { assert.equal(await withApplicationModel({ DATA_DIR: other }, () => priorDirectApproval(direct, profile, refresh)), undefined); } finally { rmSync(other, { recursive: true, force: true }); }
    const record = { jobId: previous.id, platform: previous.platform, title: previous.title, company: previous.company, location: previous.location, url: previous.url, appliedAt: '2026-11-16T00:00:00Z' } as AppliedRecord;
    assert.equal(reviewDuplicate(reused!, [record]).decision, 'duplicate');
    assert.equal(reviewDuplicate(reused!, [{ ...record, confirmationStatus: 'unconfirmed' }]).decision, 'duplicate');
  }); } finally { rmSync(directory, { recursive: true, force: true }); }
});
