import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPool } from '../server/db/index.js';
import { claimApplicationReviews, dismissApplicationReviews, finishApplicationReviews, listApplicationReviews,
  pendingReviewKeys, recordReviewedOutcome, releaseApplicationReviews, reviewSelection, saveApplicationReview } from '../server/application-reviews.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';

// Real transaction and row-lock checks in an isolated, disposable schema.
// Only synthetic account IDs and fixture.invalid jobs exist in this schema.
const schema = `application_review_test_${randomUUID().replaceAll('-', '')}`;
const pool = getPool();
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
const draft = (id: string, version = 1): PreparedApplication => ({
  id: randomUUID(), revision: createHash('sha256').update(`${id}:${version}`).digest('hex'),
  job: { id, title: `Fixture ${id}`, company: 'Fictional Employer', location: 'Sydney', url: `https://fixture.invalid/job/${id}`, platform: 'seek' },
  preparedAt: new Date(Date.UTC(2026, 0, version)).toISOString(), formUrl: `https://fixture.invalid/job/${id}/review`,
  answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume: 'Fixture CV.pdf',
});
const select = (item: PreparedApplication) => ({ id: item.id, revision: item.revision });
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)');
  await pool.query('INSERT INTO users VALUES (1),(2)');
  const ddl = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8').match(/CREATE TABLE IF NOT EXISTS application_reviews \([\s\S]*?\n\);/)![0];
  await pool.query(ddl);
  const first = draft('first'), second = draft('second');
  await saveApplicationReview('1', first); await saveApplicationReview('1', second);
  await assert.rejects(claimApplicationReviews('2', [select(first)]), /no longer ready/);
  await assert.rejects(claimApplicationReviews('1', [{ ...select(first), revision: '0'.repeat(64) }]), /no longer ready/);
  const claims = await Promise.allSettled([claimApplicationReviews('1', [select(first)]), claimApplicationReviews('1', [select(first)])]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1, 'concurrent clicks consume an approval once');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === second.id)?.status, 'ready', 'unselected jobs stay ready');
  assert.equal((await listApplicationReviews('2')).length, 0, 'another owner cannot read prepared applications');
  await releaseApplicationReviews('1', [first.id]);
  assert.equal((await listApplicationReviews('1')).find(item => item.id === first.id)?.status, 'ready');
  await claimApplicationReviews('1', [select(first)]);
  await recordReviewedOutcome('2', first.id, 'applied');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === first.id)?.status, 'approved');
  await recordReviewedOutcome('1', first.id, 'applied');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === first.id)?.status, 'applied');
  await assert.rejects(claimApplicationReviews('1', [select(first)]), /no longer ready/);
  await dismissApplicationReviews('1', [select(second)]);
  assert.deepEqual(await pendingReviewKeys('1'), []);
  const revised = draft('second', 2);
  await saveApplicationReview('1', revised);
  await assert.rejects(claimApplicationReviews('1', [select(second)]), /no longer ready/);
  await claimApplicationReviews('1', [select(revised)]);
  const changed = draft('second', 3);
  await saveApplicationReview('1', changed);
  await recordReviewedOutcome('1', revised.id, 'applied');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === changed.id)?.status, 'ready', 'a changed form requires fresh confirmation');
  await claimApplicationReviews('1', [select(changed)]);
  await finishApplicationReviews('1');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === changed.id)?.status, 'failed', 'interrupted sends cannot silently retry');
  assert.throws(() => reviewSelection([select(first), select(first)]), /Reload/);
  assert.throws(() => reviewSelection([]), /Select/);
  console.log('PASS: prepared application ownership, immutable versions, concurrent single-use approvals, selected-only execution, changed forms, dismissal and interrupted-send recovery.');
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}
