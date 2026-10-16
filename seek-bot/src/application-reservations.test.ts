import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ApplicationReservations, authorizeReservedSubmission, withApplicationAttempt } from './application-reservations.js';
import type { JobListing } from './types.js';

const job: JobListing = { id: 'one', platform: 'seek', title: 'Assistant', company: 'Fixture', location: 'Sydney', url: 'https://seek.com.au/job/one' };
const other: JobListing = { ...job, platform: 'indeed', url: 'https://au.indeed.com/viewjob?jk=one' };
function fixture(action: (journal: ApplicationReservations, directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-claims-'));
  const journal = new ApplicationReservations(directory);
  return Promise.resolve().then(() => action(journal, directory)).finally(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
}
test('different platform applications are allowed; the exact listing is claimed only once', () => fixture(journal => {
  assert.ok(journal.acquire(job)); assert.ok(journal.acquire(other)); assert.equal(journal.acquire(job), null);
}));
test('two workers reaching the same actual employer form cannot both submit', () => fixture(journal => {
  const a = journal.acquire(job)!, b = journal.acquire(other)!;
  const form = 'https://employer.fixture.invalid/apply?requisition=7';
  assert.equal(withApplicationAttempt({ journal, id: a, job }, () => authorizeReservedSubmission(form)), true);
  assert.equal(withApplicationAttempt({ journal, id: b, job: other }, () => authorizeReservedSubmission(form)), false);
  assert.equal(journal.state(a), 'pending'); assert.equal(journal.state(b), 'running');
  assert.equal(journal.authorize(a, job, form), false, 'an unconfirmed send cannot be repeated by the same agent either');
  journal.rejected(a);
  assert.equal(journal.authorize(a, job, form), true, 'observed validation rejection permits a corrected retry');
}));
test('known pre-send failures release claims; an uncertain submission remains blocked after reopening the database', () => fixture((journal, directory) => {
  const id = journal.acquire(job)!; assert.equal(journal.finish(id, { status: 'error', jobId: job.id, error: 'before send' }), false);
  const retry = journal.acquire(job)!; assert.ok(retry);
  journal.authorize(retry, job, 'https://employer.fixture.invalid/jobs/7/apply');
  assert.equal(journal.finish(retry), true);
  const reopened = new ApplicationReservations(directory);
  try { assert.equal(reopened.state(retry), 'uncertain'); assert.equal(reopened.acquire(job), null); }
  finally { reopened.close(); }
}));
test('a hard-crashed process leaves a durable reservation; another process cannot steal it', () => fixture((journal, directory) => {
  const moduleUrl = new URL('./application-reservations.js', import.meta.url).href;
  const script = `import { ApplicationReservations } from ${JSON.stringify(moduleUrl)};
    const journal=new ApplicationReservations(${JSON.stringify(directory)});
    const job=${JSON.stringify(job)}; const id=journal.acquire(job);
    if(!id || !journal.authorize(id,job,'https://employer.fixture.invalid/jobs/9/apply')) process.exit(2);
    process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
  assert.equal(journal.acquire(job), null);
}));
test('different owners never share a claim, and a budget denial cannot mark a submission as pending', () => fixture((journal, directory) => {
  const second = new ApplicationReservations(join(directory, 'another-owner'));
  try {
    const id = journal.acquire(job)!; assert.ok(second.acquire(job));
    assert.equal(withApplicationAttempt({ journal, id, job, beforeSubmit: () => false }, () => authorizeReservedSubmission(job.url)), false);
    assert.equal(journal.state(id), 'running');
  } finally { second.close(); }
}));
test('different external forms stay allowed; an already-applied form stays reserved', () => fixture(journal => {
  const a = journal.acquire(job)!, b = journal.acquire(other)!;
  assert.equal(journal.authorize(a, job, 'https://employer.fixture.invalid/form-one'), true);
  assert.equal(journal.authorize(b, other, 'https://employer.fixture.invalid/form-two'), true);
  journal.finish(a, { status: 'applied', jobId: job.id, at: new Date().toISOString() });
  assert.equal(journal.acquire(job), null);
}));
test('daily limits recover pending and confirmed sends missing from history, without counting manual applications or recorded sends twice', () => fixture(journal => {
  const a = journal.acquire(job)!;
  journal.authorize(a, job, 'https://employer.fixture.invalid/jobs/7/apply');
  assert.deepEqual(journal.unrecordedToday([]), { applications: 1, external: 1 });
  journal.finish(a, { status: 'applied', jobId: job.id, at: new Date().toISOString() });
  const record = { jobId: job.id, title: job.title, company: job.company, location: job.location, url: job.url,
    platform: 'seek' as const, appliedAt: new Date().toISOString(), score: 80, submittedByMyasis: true };
  assert.deepEqual(journal.unrecordedToday([record]), { applications: 0, external: 0 });
  const b = journal.acquire(other)!;
  journal.finish(b, { status: 'already-applied', jobId: other.id, reason: 'Existing manual application' });
  assert.deepEqual(journal.unrecordedToday([record]), { applications: 0, external: 0 });
}));
