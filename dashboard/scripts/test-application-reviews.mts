import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPool } from '../server/db/index.js';
import { claimApplicationReviews, dismissApplicationReviews, finishApplicationReviews, listApplicationReviews,
  applicationsForConfirmation, editApplicationCoverLetter, pendingReviewKeys, recordReviewedOutcome, releaseApplicationReviews, reviewSelection, saveApplicationReview } from '../server/application-reviews.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import { FREE_APPLICATIONS } from '../src/pricing.js';
import { loadUserSettings, saveUserSettings, runSettingsForUser } from '../server/settings.js';
import { applyRunPolicy } from '../server/entitlements.js';

// Real transaction and row-lock checks in an isolated, disposable schema.
// Only synthetic account IDs and fixture.invalid jobs exist in this schema.
const schema = `application_review_test_${randomUUID().replaceAll('-', '')}`;
const pool = getPool();
const previousAdmins = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = 'admin-review-fixture@example.test';
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
const draft = (id: string, version = 1): PreparedApplication => ({
  id: randomUUID(), revision: createHash('sha256').update(`${id}:${version}`).digest('hex'),
  job: { id, title: `Fixture ${id}`, company: 'Fictional Employer', location: 'Sydney', url: `https://fixture.invalid/job/${id}`, platform: 'seek' },
  preparedAt: new Date(Date.UTC(2026, 0, version)).toISOString(), formUrl: `https://www.seek.com.au/job/${id}/apply/review`,
  answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume: 'Fixture CV.pdf',
});
const select = (item: PreparedApplication) => ({ id: item.id, revision: item.revision });
const used = async (userId = '1') => {
  const { rows } = await pool.query(`SELECT
    (SELECT COALESCE(sum(successful_applications),0) FROM monthly_application_usage WHERE user_id=$1) +
    (SELECT COALESCE(sum(credits_used),0) FROM application_credit_grants WHERE user_id=$1) AS n`, [userId]);
  return Number(rows[0].n);
};
const grant = async (userId: string, external = 0) => {
  const { rows } = await pool.query(`INSERT INTO billing_purchases
    (user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid)
    VALUES ($1,$2,'job-search-pass',50,0) RETURNING id`, [userId, randomUUID()]);
  await pool.query('INSERT INTO application_credit_grants (user_id,purchase_id,credits_total) VALUES ($1,$2,50)', [userId, rows[0].id]);
  if (external) await pool.query('INSERT INTO employer_site_credit_grants (user_id,purchase_id,credits_total) VALUES ($1,$2,$3)', [userId, rows[0].id, external]);
};
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY,email TEXT NOT NULL)');
  await pool.query("INSERT INTO users VALUES (1,'owner@example.test'),(2,'other@example.test'),(3,'admin-review-fixture@example.test'),(4,'last-credit@example.test')");
  const schemaSql = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
  // Apply the actual upgrade twice: old drafts stay covered and new rows default to unpaid.
  await pool.query('CREATE TABLE review_credit_legacy (id INTEGER)');
  await pool.query('INSERT INTO review_credit_legacy VALUES (1)');
  const upgrade = schemaSql.split('\n').filter(line => line.startsWith('ALTER TABLE application_reviews ')).join('\n').replaceAll('application_reviews', 'review_credit_legacy');
  await pool.query(upgrade);
  await pool.query('INSERT INTO review_credit_legacy (id) VALUES (2)');
  await pool.query(upgrade);
  assert.deepEqual((await pool.query('SELECT credit_consumed FROM review_credit_legacy ORDER BY id')).rows.map(row => row.credit_consumed), [true, false]);
  for (const table of ['application_reviews','billing_purchases','application_credit_grants','employer_site_credit_grants','monthly_application_usage','settings']) {
    await pool.query(schemaSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  }
  await grant('1', 50);
  const first = draft('first'), second = draft('second');
  await saveApplicationReview('1', first); await saveApplicationReview('1', second);
  assert.equal(await used(), 2, 'each saved preparation spends one credit');
  await Promise.all([saveApplicationReview('1', first), saveApplicationReview('1', first)]);
  assert.equal(await used(), 2, 'replayed and concurrent saves cannot charge again');
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
  assert.equal(await used(), 2, 'confirmation and submission do not spend a second credit');
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
  assert.equal(await used(), 2, 'dismissal, changed versions and interrupted submissions never charge twice or refund preparation');
  assert.equal((await listApplicationReviews('1')).find(item => item.id === changed.id)?.status, 'failed', 'interrupted sends cannot silently retry');
  assert.throws(() => reviewSelection([select(first), select(first)]), /Reload/);
  assert.throws(() => reviewSelection([]), /Select/);
  const hundred = Array.from({ length: 100 }, (_, index) => select(draft(`batch-${index}`)));
  assert.equal(reviewSelection(hundred).length, 100, 'confirmations may use the full daily application allowance');
  assert.throws(() => reviewSelection([...hundred, select(draft('one-too-many'))]), /100/);

  const fifty = Array.from({ length: 50 }, (_, index) => `word${index}`).join(' ');
  await saveUserSettings('1', { COVER_LETTER_INSTRUCTIONS: fifty });
  await assert.rejects(saveUserSettings('1', { KEYWORDS: 'must not be saved', COVER_LETTER_INSTRUCTIONS: fifty + ' extra' }), /50 words/);
  assert.equal((await loadUserSettings('1')).KEYWORDS, undefined, 'invalid instructions cannot partially save other settings');
  const resolved = await runSettingsForUser('1');
  const policy = applyRunPolicy(resolved, { tier: 'standard', fineTune: false, advancedFilters: false, indeedApplications: false, evaluationsPerRun: 15, maxApplicationsPerRunOverride: null }, 'manual');
  assert.equal(policy.COVER_LETTER_INSTRUCTIONS, fifty, 'saved instructions survive ordinary plan policy and reach future runs');
  assert.equal((await runSettingsForUser('2')).COVER_LETTER_INSTRUCTIONS, '', 'another account cannot inherit instructions');

  const editable = { ...draft('editable'), coverLetter: 'Original letter', answers: [{ question: 'Write a cover letter', answer: 'Original letter' }, { question: 'Availability', answer: 'Two weeks' }] };
  const editingUsage = await used();
  await saveApplicationReview('1', editable);
  await assert.rejects(editApplicationCoverLetter('2', select(editable), 'Another letter'), /no longer editable/);
  const edited = await editApplicationCoverLetter('1', select(editable), 'Edited letter — with my wording.\n\nFixture Applicant');
  assert.equal(edited.coverLetter, 'Edited letter, with my wording.\n\nFixture Applicant');
  assert.equal(edited.answers[0].answer, edited.coverLetter, 'editing updates the actual cover letter form answer as well as the document');
  assert.equal(edited.answers[1].answer, 'Two weeks');
  assert.notEqual(edited.revision, editable.revision);
  await assert.rejects(claimApplicationReviews('1', [select(editable)]), /no longer ready/);
  await assert.rejects(editApplicationCoverLetter('1', select(editable), 'Stale edit'), /no longer editable/);
  await saveApplicationReview('1', editable);
  assert.equal((await listApplicationReviews('1')).find(row => row.id === edited.id)?.application.coverLetter, edited.coverLetter, 'replaying the old worker journal never overwrites the user edit');
  await claimApplicationReviews('1', [select(edited)]);
  await assert.rejects(editApplicationCoverLetter('1', select(edited), 'Too late'), /no longer editable/);
  await recordReviewedOutcome('1', edited.id, 'applied');
  await assert.rejects(editApplicationCoverLetter('1', select(edited), 'Change history'), /no longer editable/);
  assert.equal(await used(), editingUsage + 1, 'edits and confirmation never charge an additional credit');
  const failedLetter = { ...draft('failed-letter'), coverLetter: 'Original failed letter' };
  await saveApplicationReview('1', failedLetter);
  await claimApplicationReviews('1', [select(failedLetter)]);
  await recordReviewedOutcome('1', failedLetter.id, 'error', 'Submission was not confirmed.');
  const failedUsage = await used();
  const failedEdit = await editApplicationCoverLetter('1', select(failedLetter), 'Updated failed letter — without retrying it.');
  const failedRow = (await listApplicationReviews('1')).find(row => row.id === failedLetter.id)!;
  assert.equal(failedRow.status, 'failed', 'editing an uncertain or failed submission never makes it ready for another send');
  assert.equal(failedRow.detail, 'Submission was not confirmed.');
  assert.equal(failedRow.application.coverLetter, failedEdit.coverLetter);
  await assert.rejects(claimApplicationReviews('1', [select(failedEdit)]), /no longer ready/);
  assert.equal(await used(), failedUsage);
  const retrySelection = { ...select(failedEdit), retry: true };
  assert.throws(() => reviewSelection([{ ...retrySelection, retry: 'true' }]), /Reload/);
  await assert.rejects(claimApplicationReviews('2', [retrySelection]), /no longer ready/);
  await assert.rejects(claimApplicationReviews('1', [{ ...retrySelection, revision: failedLetter.revision }]), /no longer ready/);
  assert.deepEqual(await applicationsForConfirmation('1', [retrySelection]), [failedEdit], 'explicit retries reuse the exact edited draft');
  const retryClaims = await Promise.allSettled([claimApplicationReviews('1', [retrySelection]), claimApplicationReviews('1', [retrySelection])]);
  assert.equal(retryClaims.filter(result => result.status === 'fulfilled').length, 1, 'concurrent retries can claim a failed draft only once');
  await releaseApplicationReviews('1', [failedEdit.id], [retrySelection]);
  assert.equal((await listApplicationReviews('1')).find(row => row.id === failedEdit.id)?.status, 'failed', 'a refused retry stays failed and requires another explicit retry');
  await assert.rejects(claimApplicationReviews('1', [select(failedEdit)]), /no longer ready/);
  await claimApplicationReviews('1', [retrySelection]);
  await recordReviewedOutcome('1', failedEdit.id, 'already-applied', 'The board confirms the previous submission.');
  assert.equal((await listApplicationReviews('1')).find(row => row.id === failedEdit.id)?.status, 'applied', 'an existing receipt reconciles the retry without a second send');
  await assert.rejects(claimApplicationReviews('1', [retrySelection]), /no longer ready/);
  assert.equal(await used(), failedUsage, 'retry claims, refused starts and recovered receipts spend no additional credits');
  console.log('PASS: editable letters preserve other answers, reject stale/foreign edits, invalidate old approvals and keep credits unchanged; 50-word preferences persist for all plans.');

  await pool.query("INSERT INTO monthly_application_usage VALUES (4,date_trunc('month',now())::date,$1)", [FREE_APPLICATIONS - 1]);
  const lastA = draft('last-a'), lastB = draft('last-b');
  const last = await Promise.allSettled([saveApplicationReview('4', lastA), saveApplicationReview('4', lastB)]);
  assert.equal(last.filter(item => item.status === 'fulfilled').length, 1, 'concurrent preparations cannot both spend the last credit');
  assert.equal(await used('4'), FREE_APPLICATIONS);
  const remaining = await listApplicationReviews('4');
  assert.equal(remaining.length, 1, 'an unpaid preparation is not published as ready');
  const paidPreparation = remaining[0].application;
  assert.equal((await applicationsForConfirmation('4', [select(paidPreparation)])).length, 1, 'confirmation is allowed at zero balance');
  await claimApplicationReviews('4', [select(paidPreparation)]);
  await recordReviewedOutcome('4', paidPreparation.id, 'error');
  const exhaustedRetry = { ...select(paidPreparation), retry: true };
  assert.equal((await applicationsForConfirmation('4', [exhaustedRetry])).length, 1, 'a prepaid failed application can retry at zero balance');
  await claimApplicationReviews('4', [exhaustedRetry]);
  await recordReviewedOutcome('4', paidPreparation.id, 'needs-human');
  assert.equal(await used('4'), FREE_APPLICATIONS, 'another failed retry spends no extra credit');
  const retry = { ...paidPreparation, id: randomUUID(), preparedAt: '2027-01-01T00:00:00.000Z' };
  await saveApplicationReview('4', retry);
  assert.equal(await used('4'), FREE_APPLICATIONS, 'retrying a paid job after failure does not charge again');
  await assert.rejects(saveApplicationReview('4', draft('no-credit')), /No application allowance/);

  const external = draft('external');
  external.job.applicationMode = 'external';
  await grant('2', 1);
  await saveApplicationReview('2', external);
  assert.equal(await used('2'), 1);
  assert.equal(Number((await pool.query('SELECT credits_used FROM employer_site_credit_grants WHERE user_id=2')).rows[0].credits_used), 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM monthly_application_usage WHERE user_id=2')).rows[0].n), 0, 'employer-site preparation uses paid capacity, not free credits');
  const noExternal = draft('no-external'); noExternal.job.applicationMode = 'external';
  await assert.rejects(saveApplicationReview('2', noExternal), /No employer-site/);
  assert.equal((await listApplicationReviews('2')).length, 1, 'failed employer-credit checks roll back the draft and ordinary charge');
  assert.equal(await used('2'), 1);
  await saveApplicationReview('3', draft('admin'));
  assert.equal(await used('3'), 0, 'admin accounts keep unlimited applications');
  console.log('PASS: preparation credits, atomic last-credit concurrency, paid/employer allowances, zero-balance confirmation, retries and admin exemption.');
  if (process.env.SEMI_AUTO_E2E_REPORT) {
    const report = JSON.parse(readFileSync(process.env.SEMI_AUTO_E2E_REPORT, 'utf8')) as { prepared: PreparedApplication[] };
    assert.equal(report.prepared.length, 5);
    const before = await used();
    for (const application of report.prepared) await saveApplicationReview('1', application);
    assert.equal(await used(), before + 5, 'five prepared applications spend exactly five credits');
    const ready = (await listApplicationReviews('1')).filter(row => row.status === 'ready');
    assert.equal(ready.length, 5, 'the five browser-filled drafts survive persistence');
    const selected = report.prepared.map(select);
    assert.equal((await claimApplicationReviews('1', selected)).length, 5);
    await assert.rejects(claimApplicationReviews('1', selected), /no longer ready/);
    for (const application of report.prepared) await recordReviewedOutcome('1', application.id, 'applied');
    assert.equal(await used(), before + 5, 'submitting all five confirmed applications spends no additional credits');
    assert.equal((await listApplicationReviews('1')).filter(row => report.prepared.some(draft => draft.id === row.id) && row.status === 'applied').length, 5);
    console.log('PASS: all five browser-prepared applications persist, are claimed once by their owner and record their confirmed outcomes.');
  }
  console.log('PASS: prepared application ownership, immutable versions, concurrent single-use approvals, selected-only execution, changed forms, dismissal and interrupted-send recovery.');
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
  if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousAdmins;
}
