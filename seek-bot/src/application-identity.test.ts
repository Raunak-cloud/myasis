import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationKeys, applicationUrlKey, applicationFormKey, sameApplication } from './application-identity.js';
import type { AppliedRecord, JobListing } from './types.js';
const job: JobListing = { id: '123', title: 'Assistant', company: 'Fixture', location: 'Sydney', platform: 'seek', url: 'https://www.seek.com.au/job/123' };
const prior: AppliedRecord = { jobId: '123', title: job.title, company: job.company, location: job.location, url: job.url, platform: 'seek', appliedAt: '', score: 80 };
test('same vacancy through different platforms or forms is allowed, even with the same numeric job id', () => {
  assert.equal(sameApplication(prior, { ...job, platform: 'indeed', url: 'https://au.indeed.com/viewjob?jk=123' }), false);
  assert.equal(sameApplication(prior, { ...job, id: '456', url: 'https://www.seek.com.au/job/456' }), false);
  assert.equal(sameApplication(prior, job), true);
});
test('exact application destination shared by different platforms is the same form', () => {
  const url = 'https://careers.fixture.invalid/apply?job=123&tenant=one';
  assert.equal(sameApplication({ ...prior, url }, { ...job, id: 'other', platform: 'indeed', applicationUrl: url }), true);
  assert.equal(sameApplication({ ...prior, url }, { ...job, id: 'other', platform: 'indeed', applicationUrl: url.replace('job=123', 'job=456') }), false);
});
test('canonical URLs preserve job/tenant/query/hash routing and discard only advertising attribution', () => {
  assert.equal(applicationUrlKey('https://www.fixture.invalid/apply?utm_source=seek&job=7&tenant=a#heading'), 'https://fixture.invalid/apply?job=7&tenant=a');
  assert.notEqual(applicationUrlKey('https://fixture.invalid/#/jobs/7'), applicationUrlKey('https://fixture.invalid/#/jobs/8'));
  assert.equal(applicationUrlKey('javascript:alert(1)'), null);
  assert.ok(applicationKeys(job).includes('listing:seek:123'));
});
test('a shared generic form template cannot suppress unrelated vacancies', () => {
  const template = 'https://employer.fixture.invalid/apply';
  assert.notEqual(applicationFormKey(job, template), applicationFormKey({ ...job, title: 'Lab technician' }, template));
  const posting = template + '?requisition=123';
  assert.equal(applicationFormKey(job, posting), applicationFormKey({ ...job, title: 'Renamed listing' }, posting));
});
test('unreadable owned history stops the run rather than appearing to be an empty account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-identity-history-'));
  process.env.DATA_DIR = directory;
  process.env.CELERIS_API_KEY = 'fixture-only';
  const { AppliedIndex } = await import('./store.js');
  try {
    assert.equal(new AppliedIndex().all.length, 0, 'a genuinely new account may have no history yet');
    for (const invalid of ['{broken', '{}']) {
      writeFileSync(join(directory, 'applied.json'), invalid);
      assert.throws(() => new AppliedIndex(), /history could not be read/);
    }
    writeFileSync(join(directory, 'applied.json'), JSON.stringify([prior]));
    assert.equal(new AppliedIndex().all[0].jobId, prior.jobId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
