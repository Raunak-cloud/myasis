import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { withApplicationModel } from './application-model.js';
import { cachedAssessment } from './pipeline.js';
import { ReviewCache, listingFingerprint, reviewContextFingerprint } from './review-cache.js';
import { FIT_ASSESSMENT_VERSION } from './model-versions.js';
import { loadSavedAnswers, buildKnowledgeContext, knowledgeContextFingerprint } from './knowledge.js';
import { loadResumes, resolveResume, resumeDirectory } from './resume.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-account-cache-'));
const owners = ['one', 'two'].map(owner => {
  const dataDir = join(directory, owner);
  mkdirSync(join(dataDir, 'resumes'), { recursive: true });
  writeFileSync(join(dataDir, 'answers.json'), JSON.stringify([{ question: 'Fictional fact', answer: owner }]));
  writeFileSync(join(dataDir, 'resumes.json'), JSON.stringify([{ id: owner, label: owner, fileName: 'cv.txt', isDefault: true }]));
  writeFileSync(join(dataDir, 'resumes', 'cv.txt'), 'Private fixture evidence for owner ' + owner);
  return { ...process.env, DATA_DIR: dataDir, CELERIS_API_KEY: 'fictional-only' };
});
const profile = { name: 'Fixture', nationality: '', phone: '', email: 'fixture@example.test',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Retail',
  skills: ['Customer service'], excludedDomains: [], securityClearance: '' };
const job = { id: 'fixture', title: 'Retail assistant', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid' };
const accept = (value: { ok: boolean }) => value.ok;

try {
  await withApplicationModel(owners[0], async () => {
    let computations = 0;
    const compute = async () => ({ ok: true, computation: ++computations });
    const prior = { version: 'model-owned-fit-v13', prompt: 'Unchanged candidate and listing' };
    assert.equal((await cachedAssessment(prior, compute, accept)).computation, 1);
    const current = { ...prior, version: FIT_ASSESSMENT_VERSION };
    assert.equal((await cachedAssessment(current, compute, accept)).computation, 2,
      'Corrected fit contracts cannot reuse pre-fix decisions');
    assert.equal((await cachedAssessment(current, compute, accept)).computation, 2);
  });

  let started = 0;
  const releases: Array<() => void> = [];
  const compute = () => new Promise<{ ok: boolean; computation: number }>(done => {
    const computation = ++started;
    releases.push(() => done({ ok: true, computation }));
  });
  const scoped = (environment: typeof owners[number]) => withApplicationModel(environment, async () => {
    const value = await cachedAssessment({ version: 'concurrent-accounts' }, compute, accept);
    const owner = environment.DATA_DIR.split(/[\\/]/).at(-1)!;
    assert.equal(loadSavedAnswers()[0].answer, owner, 'Saved answers remain scoped after an await');
    assert.equal(resolveResume()?.id, owner, 'Selected resume belongs to the active account');
    assert.equal(loadResumes()[0].id, owner);
    assert.equal(resumeDirectory(), join(environment.DATA_DIR, 'resumes'));
    const knowledge = await buildKnowledgeContext();
    assert.ok(knowledge.includes('owner ' + owner));
    const other = owner === 'one' ? 'two' : 'one';
    assert.ok(!knowledge.includes('owner ' + other), 'Extracted knowledge never crosses accounts');
    return { ...value, fingerprint: reviewContextFingerprint(profile), knowledgeFingerprint: knowledgeContextFingerprint() };
  });
  const first = scoped(owners[0]), second = scoped(owners[1]);
  assert.equal(started, 2, 'Identical concurrent work for different accounts must make independent computations');
  releases.forEach(release => release());
  const results = await Promise.all([first, second]);
  assert.notEqual(results[0].computation, results[1].computation);
  assert.notEqual(results[0].fingerprint, results[1].fingerprint);
  assert.notEqual(results[0].knowledgeFingerprint, results[1].knowledgeFingerprint);
  for (let index = 0; index < owners.length; index++) await withApplicationModel(owners[index], async () => {
    const value = await cachedAssessment<{ ok: boolean; computation: number }>({ version: 'concurrent-accounts' }, () => { throw new Error('Unexpected account cache miss'); }, accept);
    assert.equal(value.computation, results[index].computation, 'Disk reuse remains inside its own account');
  });

  const cachePath = join(owners[0].DATA_DIR, 'fixture-review-cache.jsonl');
  writeFileSync(cachePath, JSON.stringify({ jobId: job.id, title: job.title, company: job.company,
    reviewedAt: new Date().toISOString(), reason: 'Fixture decision', disposition: 'fit-mismatch',
    listingFingerprint: listingFingerprint(job), contextFingerprint: results[0].fingerprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }) + '\n');
  const review = new ReviewCache({ cachePath });
  assert.equal(review.suppression(job, results[1].fingerprint), null);
  assert.equal(review.suppression(job, results[0].fingerprint)?.reason, 'Fixture decision');
  console.log('PASS: fit-contract invalidation and concurrent account isolation for assessment cache, saved answers, resumes, extracted knowledge and historical review; no model calls');
} finally {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-account-cache-'));
  rmSync(directory, { recursive: true, force: true });
}
