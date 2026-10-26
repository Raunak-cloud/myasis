import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewDuplicate, reviewCurrentDuplicate, DuplicateReviewQueue } from './duplicate-review.js';
import { withApplicationModel } from './application-model.js';
import type { AppliedRecord, JobListing } from './types.js';

const root = mkdtempSync(join(tmpdir(), 'owtomate-duplicate-review-'));
after(() => rmSync(root, { recursive: true, force: true }));
const job: JobListing = { id: '95337391', title: 'Developer', company: 'Fixture', location: 'Sydney',
  platform: 'seek', url: 'https://www.seek.com.au/job/95337391' };
const prior: AppliedRecord = { jobId: job.id, title: job.title, company: job.company, location: job.location,
  platform: 'seek', url: job.url, appliedAt: '2026-10-26T14:00:00Z', score: 85 };
function owner(name: string, records: AppliedRecord[] = []) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'applied.json'), JSON.stringify(records));
  return { DATA_DIR: dir, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' };
}

test('matching checks the entire history, including records beyond model-context limits', () => {
  const history = Array.from({ length: 2000 }, (_, n) => ({ ...prior, jobId: String(n), url: `https://fixture.invalid/job/${n}` }));
  const result = reviewDuplicate(job, [...history, prior]);
  assert.equal(result.decision, 'duplicate');
  assert.equal(result.evidence?.jobId, prior.jobId);
  assert.equal(result.evidence?.source, 'history');
});

test('exact IDs and cross-board destinations block, while same-company roles and different vacancies remain eligible', () => {
  assert.equal(reviewDuplicate(job, [prior]).decision, 'duplicate');
  const destination = 'https://employer.fixture.invalid/apply?job=7&tenant=one';
  const fromIndeed: JobListing = { ...job, id: 'indeed-key', platform: 'indeed', applicationUrl: destination + '&utm_source=indeed' };
  assert.equal(reviewDuplicate(fromIndeed, [{ ...prior, url: destination }]).decision, 'duplicate');
  assert.equal(reviewDuplicate(fromIndeed, [{ ...prior, applicationUrl: destination }]).decision, 'duplicate', 'retain the actual employer destination alongside the original board advert');
  assert.equal(reviewDuplicate({ ...fromIndeed, applicationUrl: destination.replace('job=7', 'job=8') }, [{ ...prior, url: destination }]).decision, 'clear');
  assert.equal(reviewDuplicate({ ...job, id: 'new-role', url: 'https://www.seek.com.au/job/new-role' }, [prior]).decision, 'clear');
  assert.equal(reviewDuplicate({ ...job, platform: 'indeed', url: 'https://au.indeed.com/viewjob?jk=95337391' }, [prior]).decision, 'clear');
});

test('board evidence is decisive even when the owner has no local application record', () => {
  const result = reviewDuplicate({ ...job, alreadyApplied: true, appliedNote: 'You applied on 26 Oct' }, []);
  assert.equal(result.decision, 'duplicate');
  assert.equal(result.reason, 'You applied on 26 Oct');
  assert.equal(result.evidence?.source, 'board');
});

test('fresh handoff uses the correct owner and notices submissions recorded since an earlier clearance', async () => {
  const one = owner('one', [prior]), two = owner('two');
  const results = await Promise.all([one, two].map(environment => withApplicationModel(environment, async () => {
    await Promise.resolve();
    return reviewCurrentDuplicate(job).decision;
  })));
  assert.deepEqual(results, ['duplicate', 'clear']);
  writeFileSync(join(two.DATA_DIR, 'applied.json'), JSON.stringify([prior]));
  assert.equal(withApplicationModel(two, () => reviewCurrentDuplicate(job)).decision, 'duplicate');
});

test('corrupt history cannot silently clear a job', () => {
  const environment = owner('corrupt');
  writeFileSync(join(environment.DATA_DIR, 'applied.json'), '{broken');
  assert.throws(() => withApplicationModel(environment, () => reviewCurrentDuplicate(job)), /history could not be read/);
});

test('equivalent cross-board forms wait for a result while unrelated vacancies can progress', async () => {
  const queue = new DuplicateReviewQueue();
  const applicationUrl = 'https://employer.fixture.invalid/jobs/7';
  const release = await queue.enter({ ...job, applicationUrl });
  let secondEntered = false;
  const second = queue.enter({ ...job, id: 'another-board-key', platform: 'indeed', applicationUrl })
    .then(release => { secondEntered = true; return release; });
  const releaseOther = await queue.enter({ ...job, id: 'different-vacancy', applicationUrl: applicationUrl.replace('/7', '/8') });
  assert.equal(secondEntered, false);
  releaseOther();
  release();
  const releaseSecond = await second;
  assert.equal(secondEntered, true);
  release(); // a stale release cannot unlock a later owner's turn
  let thirdEntered = false;
  const third = queue.enter({ ...job, applicationUrl }).then(release => { thirdEntered = true; return release; });
  await Promise.resolve();
  assert.equal(thirdEntered, false);
  releaseSecond();
  (await third)();
});

test('known duplicates return before instructions, cached suitability or any model call', async () => {
  const environment = owner('no-model', [prior]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('No model call permitted for a confirmed duplicate'); };
  try {
    const { assessFit } = await import('./llm.js');
    const result = await withApplicationModel(environment, () => assessFit(job, {} as never));
    assert.equal(result.shouldApply, false);
    assert.equal(result.duplicateReview?.decision, 'duplicate');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
