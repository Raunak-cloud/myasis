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

test('Workday manual entry and resumed apply routes preserve the same vacancy identity only', () => {
  const manual = 'https://fixture.wd3.myworkdayjobs.com/en-US/External/job/Sydney/Developer_R123/apply/applyManually?tenant=one';
  const resumed = manual.replace('/apply/applyManually', '/apply');
  assert.equal(applicationFormKey(job, manual), applicationFormKey(job, resumed));
  assert.notEqual(applicationUrlKey(manual), applicationUrlKey(resumed), 'the original URL remains intact for browser use');
  for (const different of [resumed.replace('R123', 'R456'), resumed.replace('/External/', '/OtherSite/'), resumed.replace('tenant=one', 'tenant=two'), resumed + '&token=unknown']) {
    assert.notEqual(applicationFormKey(job, manual), applicationFormKey(job, different));
  }
  for (const host of ['fixture.invalid', 'fixture.myworkdayjobs.com.evil.invalid']) {
    const otherManual = manual.replace('fixture.wd3.myworkdayjobs.com', host);
    assert.notEqual(applicationFormKey(job, otherManual), applicationFormKey(job, otherManual.replace('/apply/applyManually', '/apply')), 'unverified providers retain distinct routes');
  }
});

test('a new SEEK handoff session keeps the same vacancy identity and preserves routing', () => {
  const first = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-2222-3333-4444-555555555555/screening?tenant=one&seek-token=first';
  const second = first.replace('seek-token=first', 'seek-token=second');
  assert.equal(applicationFormKey(job, first), applicationFormKey(job, second));
  assert.equal(new URL(first).searchParams.get('seek-token'), 'first', 'canonicalization never changes the live handoff URL');
  for (const changed of [second.replace('tenant=one', 'tenant=two'), second.replace('555555555555', '666666666666'), second + '&job=another', second + '&token=unknown']) {
    assert.notEqual(applicationFormKey(job, first), applicationFormKey(job, changed), 'vacancy, tenant and unknown token parameters remain part of identity');
  }
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
