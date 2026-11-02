import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { getPool, query } from './db/index.js';
import { userDir, USERS_DIR } from './userdata.js';
import { saveApplicationReview, holdApplicationReview, releaseApplicationReviewHold, applicationsForConfirmation, claimApplicationReviews, pendingReviewKeys, listApplicationReviews, editApplicationCoverLetter } from './application-reviews.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import { preserveDocument, verifiedDocumentPath } from '../../seek-bot/src/application-documents.js';
import { applicationRevision } from '../../seek-bot/src/application-review-content.js';

// Real independent local PostgreSQL transactions; entirely synthetic owners,
// private fixture directory and a generated disposable schema. No production.
const pool = getPool(), url = new URL(String(pool.options.connectionString));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Hold tests require a local database.');
const schema = `operator_hold_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^operator_hold_[a-f0-9]{32}$/);
const owner = `9${Date.now()}`, other = String(BigInt(owner) + 1n), actor = String(BigInt(owner) + 2n), outsider = String(BigInt(owner) + 3n);
const directory = resolve(userDir(owner));
assert.ok(directory.startsWith(resolve(USERS_DIR) + sep) && directory.endsWith(sep + owner) && !existsSync(directory));
const previousAdmins = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = 'owner@hold.fixture.invalid,operator@hold.fixture.invalid,other@hold.fixture.invalid';
const admin = new pg.Client({ connectionString: pool.options.connectionString });
let created = false, directoryCreated = false;
const run = '1', started = new Date(Date.now() - 60_000), log: string[] = [];
const draft = (job: string, delta = 0): PreparedApplication => ({ id: randomUUID(), revision: randomUUID().replaceAll('-', '').repeat(2),
  job: { id: job, title: 'Synthetic analyst', company: 'Fixture', platform: 'seek', location: 'Sydney', url: `https://seek.fixture.invalid/job/${job}` },
  formUrl: `https://seek.fixture.invalid/job/${job}/apply`, preparedAt: new Date(Date.now() - 10_000 + delta).toISOString(),
  answers: [{ question: 'Synthetic required fact', answer: 'Unverified fixture value' }], resume: 'Fixture CV.pdf' });
const selection = (item: PreparedApplication) => ({ id: item.id, revision: item.revision });
const publish = (item: PreparedApplication) => {
  log.push(JSON.stringify({ ts: new Date().toISOString(), status: 'prepared', draft: item }));
  writeFileSync(resolve(directory, 'run-log.jsonl'), log.join('\n') + '\n');
};
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  pool.options.options = `-c search_path=${schema}`;
  await query('CREATE TABLE users(id BIGINT PRIMARY KEY,email TEXT,blocked_at TIMESTAMPTZ); CREATE TABLE run_starts(id BIGINT PRIMARY KEY,user_id BIGINT,started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ);');
  await query('INSERT INTO users VALUES($1,$2,NULL),($3,$4,NULL),($5,$6,NULL),($7,$8,NULL)', [owner, 'owner@hold.fixture.invalid', other, 'other@hold.fixture.invalid', actor, 'operator@hold.fixture.invalid', outsider, 'nonadmin@hold.fixture.invalid']);
  await query('INSERT INTO run_starts VALUES($1,$2,$3,NULL)', [run, owner, started]);
  const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  for (const table of ['application_reviews', 'application_review_operator_holds']) {
    const statement = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
    assert.ok(statement, `Missing ${table} schema`); await query(statement);
  }
  await query('CREATE UNIQUE INDEX application_review_one_active_hold_idx ON application_review_operator_holds(user_id,job_key) WHERE released_at IS NULL');
  mkdirSync(directory, { recursive: false }); directoryCreated = true;

  const first = draft('before-import'); publish(first);
  await assert.rejects(holdApplicationReview(outsider, owner, selection(first), 'Fixture unknown fact', run), /administrator/);
  await assert.rejects(holdApplicationReview(actor, other, selection(first), 'Fixture unknown fact', run), /does not belong/);
  await assert.rejects(holdApplicationReview(actor, owner, { ...selection(first), revision: 'f'.repeat(64) }, 'Fixture unknown fact', run), /exact draft/);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1', [actor]);
  await assert.rejects(holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', run), /administrator/);
  await query('UPDATE users SET blocked_at=NULL WHERE id=$1', [actor]);
  await query('UPDATE users SET blocked_at=now() WHERE id=$1', [owner]);
  await assert.rejects(holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', run), /unavailable or blocked/);
  await query('UPDATE users SET blocked_at=NULL WHERE id=$1', [owner]);
  const held = await holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', run);
  await assert.rejects(query('UPDATE application_review_operator_holds SET released_at=now(),released_by_user_id=$2,resolution_evidence=NULL WHERE id=$1', [held.id, actor]), /check constraint/, 'SQL NULL must not bypass human resolution evidence');
  assert.equal((await query('SELECT * FROM application_reviews')).length, 0, 'holding before import creates no fake ready draft or credit consumption');
  assert.ok((await pendingReviewKeys(owner)).includes('listing:seek:before-import'));
  assert.deepEqual(await pendingReviewKeys(other), []);
  assert.equal((await holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', run)).id, held.id, 'exact administrative retry is idempotent');
  const planFile = resolve(directory, 'operator-plan.json');
  const plan = { version: 1, holds: [{ actorUserId: actor, userId: owner, draftId: first.id, revision: first.revision, sourceRunId: run, reason: 'Fixture unknown fact' }] };
  const cliUrl = new URL(String(pool.options.connectionString)); cliUrl.searchParams.set('options', `-c search_path=${schema}`);
  const cli = (verify: boolean) => execFileSync(process.execPath, [fileURLToPath(new URL('../../seek-bot/node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../scripts/apply-operator-holds.mts', import.meta.url)), ...(verify ? ['--verify'] : []), planFile],
  { env: { ...process.env, DATABASE_URL: cliUrl.href }, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(planFile, JSON.stringify(plan));
  assert.match(cli(false), /Operator hold .* active/);
  assert.match(cli(true), /cannot be confirmed/);
  writeFileSync(planFile, JSON.stringify({ ...plan, holds: [{ ...plan.holds[0], sourceRunId: '999' }] }));
  assert.throws(() => cli(true), /Command failed/, 'the deployed verification command must reject a changed source-run identity');
  writeFileSync(planFile, JSON.stringify(plan));
  await saveApplicationReview(owner, first);
  await assert.rejects(applicationsForConfirmation(owner, [selection(first)]), /no longer ready/);
  await assert.rejects(claimApplicationReviews(owner, [selection(first)]), /no longer ready/);
  await assert.rejects(editApplicationCoverLetter(owner, selection(first), 'Fixture cover letter'), /no longer editable/);
  let visible = (await listApplicationReviews(owner))[0];
  assert.equal(visible.status, 'ready'); assert.equal(visible.detail, null);
  assert.equal(visible.operator_hold?.actorUserId, actor);
  assert.deepEqual(visible.application.answers, first.answers, 'the hold never changes candidate answers');
  const before = (await query('SELECT credit_consumed FROM application_reviews WHERE user_id=$1', [owner]))[0];
  const replacement = { ...first, id: randomUUID(), revision: 'b'.repeat(64), preparedAt: new Date().toISOString() };
  await saveApplicationReview(owner, replacement);
  visible = (await listApplicationReviews(owner))[0];
  assert.equal(visible.id, replacement.id); assert.equal(visible.operator_hold?.draftId, first.id, 'later imports preserve original hold attribution');
  writeFileSync(resolve(directory, 'run-log.jsonl'), '', 'utf8');
  assert.equal((await holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', run)).id, held.id, 'an existing hold survives a new draft and rotated working journal without rewriting its evidence');
  await assert.rejects(holdApplicationReview(actor, owner, selection(first), 'Fixture unknown fact', '999'), /different operator, source or reason/);
  writeFileSync(resolve(directory, 'run-log.jsonl'), log.join('\n') + '\n');
  await assert.rejects(claimApplicationReviews(owner, [selection(replacement)]), /no longer ready/);
  assert.deepEqual((await query('SELECT credit_consumed FROM application_reviews WHERE user_id=$1', [owner]))[0], before, 'holding and replacing do not manipulate the credit flag');
  await assert.rejects(releaseApplicationReviewHold(outsider, owner, held.id, selection(first), selection(replacement), 'Human fixture reply'), /administrator/);
  await assert.rejects(releaseApplicationReviewHold(actor, owner, held.id, selection(first), selection(replacement), ''), /resolution evidence/);
  await assert.rejects(releaseApplicationReviewHold(actor, owner, held.id, { ...selection(first), revision: 'f'.repeat(64) }, selection(replacement), 'Human fixture reply'), /original held draft/);
  await assert.rejects(releaseApplicationReviewHold(actor, owner, held.id, selection(first), selection(first), 'Human fixture reply'), /current unconfirmed/);
  await releaseApplicationReviewHold(actor, owner, held.id, selection(first), selection(replacement), 'Operator verified the explicit synthetic human response.');
  assert.equal((await applicationsForConfirmation(owner, [selection(replacement)]))[0].id, replacement.id);
  const audit = (await query('SELECT draft_id::text,revision,reason,actor_user_id::text,released_at,released_by_user_id::text,resolution_evidence FROM application_review_operator_holds'))[0];
  assert.equal(audit.draft_id, first.id); assert.equal(audit.revision, first.revision); assert.equal(audit.reason, 'Fixture unknown fact'); assert.equal(audit.actor_user_id, actor);
  assert.ok(audit.released_at); assert.equal(audit.released_by_user_id, actor); assert.ok(audit.resolution_evidence);

  for (const status of ['approved', 'applied']) {
    const item = draft(status); await saveApplicationReview(owner, item);
    await query('UPDATE application_reviews SET status=$3 WHERE user_id=$1 AND id=$2', [owner, item.id, status]);
    await assert.rejects(holdApplicationReview(actor, owner, selection(item), 'Do not overwrite a confirmed status.'), /already confirmed/);
    assert.equal((await query('SELECT status FROM application_reviews WHERE user_id=$1 AND id=$2', [owner, item.id]))[0].status, status);
  }
  for (let i = 0; i < 6; i++) {
    const item = draft(`claim-race-${i}`); await saveApplicationReview(owner, item);
    const operations = [() => holdApplicationReview(actor, owner, selection(item), 'Concurrent fixture hold'), () => claimApplicationReviews(owner, [selection(item)])];
    const results = await Promise.allSettled((i % 2 ? operations : [...operations].reverse()).map(action => action()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'hold and claim cannot both succeed');
    const state = (await query(`SELECT r.status,EXISTS(SELECT 1 FROM application_review_operator_holds h WHERE h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL) held
      FROM application_reviews r WHERE r.user_id=$1 AND r.id=$2`, [owner, item.id]))[0];
    assert.ok(!(state.status === 'approved' && state.held));
  }
  for (let i = 0; i < 6; i++) {
    const item = draft(`import-race-${i}`); publish(item);
    await Promise.all(i % 2 ? [saveApplicationReview(owner, item), holdApplicationReview(actor, owner, selection(item), 'Import race hold', run)]
      : [holdApplicationReview(actor, owner, selection(item), 'Import race hold', run), saveApplicationReview(owner, item)]);
    await assert.rejects(claimApplicationReviews(owner, [selection(item)]), /no longer ready/);
  }
  const letterText = 'Original candidate letter.', file = resolve(directory, 'Uploaded letter.txt');
  writeFileSync(file, letterText);
  const artifact = preserveDocument(file, directory);
  const document = { role: 'cover-letter' as const, provenance: 'file' as const, fileId: 'supporting:fixture', name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes, text: letterText };
  const attached = { ...draft('editable-attachment'), coverLetter: letterText, documents: [document] };
  await saveApplicationReview(owner, attached);
  await assert.rejects(editApplicationCoverLetter(other, selection(attached), 'Foreign edit'), /no longer editable/);
  const changedLetter = await editApplicationCoverLetter(owner, selection(attached), 'Candidate edited letter.');
  assert.equal(changedLetter.coverLetter, 'Candidate edited letter.');
  assert.notEqual(changedLetter.revision, attached.revision);
  assert.notEqual(changedLetter.documents?.[0].sha256, artifact.sha256);
  const roundTrip = (await listApplicationReviews(owner)).find(item => item.id === changedLetter.id)!.application;
  assert.equal(applicationRevision(roundTrip), changedLetter.revision, 'PostgreSQL JSONB key ordering must not change a document approval digest');
  assert.equal(readFileSync(verifiedDocumentPath(document, directory), 'utf8'), letterText, 'editing preserves the original uploaded bytes');
  assert.equal(readFileSync(verifiedDocumentPath(changedLetter.documents![0], directory), 'utf8'), changedLetter.coverLetter);
  await assert.rejects(applicationsForConfirmation(owner, [selection(attached)]), /no longer ready/);
  assert.equal((await applicationsForConfirmation(owner, [selection(changedLetter)]))[0].revision, changedLetter.revision);
  console.log('PASS: exact pre/post-import operator holds, attribution, ownership, blocked accounts, unchanged answers/credits, explicit resolution, approved/applied protection, six claim/hold and six import/hold races; owner-isolated attached letter edits preserve original bytes and invalidate stale approvals in local PostgreSQL.');
} finally {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (directoryCreated) { assert.ok(directory.startsWith(resolve(USERS_DIR) + sep) && directory.endsWith(sep + owner)); rmSync(directory, { recursive: true, force: true }); }
  if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousAdmins;
}
