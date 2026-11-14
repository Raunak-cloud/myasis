import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationSkipMemory } from './application-skip-memory.js';
import { APPLICATION_OUTCOMES_FILE, archiveApplicationOutcomes } from './application-outcome-journal.js';
import { listingFingerprint } from './review-cache.js';
import type { ApplyOutcome, JobListing } from './types.js';

const job: JobListing = { id: 'vacancy-1', platform: 'indeed', title: 'Data Analyst', company: 'Employer', location: 'Sydney',
  url: 'https://au.indeed.com/viewjob?jk=vacancy-1', applicationUrl: 'https://careers.employer.org/jobs/1',
  description: 'Data analysis in Sydney', teaser: 'Data analysis', fitReview: { score: 90, reason: 'Suitable', evidence: [],
    contextFingerprint: 'owner-context', contentFingerprint: 'full-ad' } };
job.discoveryFingerprint = listingFingerprint(job);
const skip: ApplyOutcome = { status: 'skipped', jobId: job.id, reason: 'The employer vacancy is in a different country.' };
const at = '2026-11-14T00:00:00Z';
function fixture(fn: (dir: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'application-skips-'));
  try { fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function journal(dir: string, rows: unknown[]) {
  const saved = join(dir, APPLICATION_OUTCOMES_FILE); if (existsSync(saved)) unlinkSync(saved);
  writeFileSync(join(dir, 'run-log.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
}
function row(outcome: ApplyOutcome, state?: unknown, snapshot = job) {
  return { ts: at, ...outcome, technicalAttempt: { job: snapshot, runId: 'previous-run' }, ...(state ? { applicationSkip: state } : {}) };
}

test('final application skips survive fresh runs, while a separate user, board or vacancy stays eligible', () => fixture(dir => {
  const first = new ApplicationSkipMemory(dir), state = first.remember(job, skip, 'owner-context');
  assert.ok(state); journal(dir, [row(skip, state)]);
  assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context')?.reason, skip.reason);
  assert.equal(new ApplicationSkipMemory(dir).prior({ ...job, platform: 'seek' }, 'owner-context'), undefined);
  assert.equal(new ApplicationSkipMemory(dir).prior({ ...job, id: 'vacancy-2' }, 'owner-context'), undefined);
  fixture(other => assert.equal(new ApplicationSkipMemory(other).prior(job, 'owner-context'), undefined));
}));

test('changed cards and candidate context release a skip without rewriting completed suitability reviews', () => fixture(dir => {
  const memory = new ApplicationSkipMemory(dir); memory.remember(job, skip, 'owner-context');
  assert.equal(memory.prior(job, 'new-preferences'), undefined);
  assert.equal(memory.prior({ ...job, discoveryFingerprint: 'changed-advert' }, 'owner-context'), undefined);
  assert.ok(memory.prior(job, 'owner-context'));
  assert.equal(job.fitReview?.score, 90);
}));

test('relevant accepted or pending login changes release skips; another employer does not', () => fixture(dir => {
  writeFileSync(join(dir, 'site-credentials.json'), JSON.stringify({ 'careers.employer.org|candidate': { employer: 'employer', status: 'external', at } }));
  const memory = new ApplicationSkipMemory(dir); memory.remember(job, skip, 'owner-context');
  writeFileSync(join(dir, 'pending-site-credentials.json'), JSON.stringify({ '["other.org","candidate","other employer","create_account"]': { phase: 'prepared', at } }));
  assert.ok(memory.prior(job, 'owner-context'));
  writeFileSync(join(dir, 'site-credentials.json'), JSON.stringify({ 'careers.employer.org|candidate': { employer: 'employer', status: 'accepted', at } }));
  assert.equal(memory.prior(job, 'owner-context'), undefined);
  memory.remember(job, skip, 'owner-context');
  writeFileSync(join(dir, 'pending-site-credentials.json'), JSON.stringify({ '["careers.employer.org","candidate","employer","create_account"]': { phase: 'needs_verification', at } }));
  assert.equal(memory.prior(job, 'owner-context'), undefined);
}));

test('technical failures, unknown delivery, required questions and account-attention tasks never become permanent skips', () => fixture(dir => {
  const outcomes: ApplyOutcome[] = [
    { status: 'error', jobId: job.id, error: 'Unreachable' },
    { ...skip, reason: 'Browser disconnected before the form opened' },
    { ...skip, reason: 'Budget exhausted' }, { ...skip, reason: 'CAPTCHA verification failed' },
    { ...skip, submitPressed: true },
    { status: 'needs-human', jobId: job.id, reason: 'Personal answer needed', url: job.url },
  ];
  for (const outcome of outcomes) {
    const memory = new ApplicationSkipMemory(dir);
    assert.equal(memory.remember(job, outcome, 'owner-context'), undefined);
    journal(dir, [row(outcome)]);
    assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context'), undefined);
  }
}));

test('historical final skips are adopted read-only; newer account access, incomplete or damaged history is not', () => fixture(dir => {
  journal(dir, [row(skip)]);
  assert.ok(new ApplicationSkipMemory(dir).prior(job, 'owner-context'));
  writeFileSync(join(dir, 'site-credentials.json'), JSON.stringify({ 'careers.employer.org|candidate': { employer: 'employer', status: 'accepted', at: '2026-11-14T01:00:00Z' } }));
  assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context'), undefined);
  writeFileSync(join(dir, 'site-credentials.json'), '{damaged');
  assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context'), undefined);
}));

test('the newest actual application outcome supersedes a previous skip, while discovery-only rows do not', () => fixture(dir => {
  const state = new ApplicationSkipMemory(dir).remember(job, skip, 'owner-context');
  journal(dir, [row(skip, state), { ts: at, status: 'skipped', jobId: job.id, reason: 'Listing age' }]);
  assert.ok(new ApplicationSkipMemory(dir).prior(job, 'owner-context'));
  journal(dir, [row(skip, state), row({ status: 'error', jobId: job.id, error: 'A later technical attempt failed' })]);
  assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context'), undefined);
}));

test('per-owner memory survives run-log rotation and historical export is idempotent', () => fixture(dir => {
  journal(dir, [row(skip)]);
  archiveApplicationOutcomes(dir);
  const before = readFileSync(join(dir, APPLICATION_OUTCOMES_FILE), 'utf8');
  archiveApplicationOutcomes(dir);
  assert.equal(readFileSync(join(dir, APPLICATION_OUTCOMES_FILE), 'utf8'), before);
  unlinkSync(join(dir, 'run-log.jsonl'));
  assert.ok(new ApplicationSkipMemory(dir).prior(job, 'owner-context'));
  const next = new ApplicationSkipMemory(dir);
  next.remember(job, { status: 'error', jobId: job.id, error: 'New technical attempt' }, 'owner-context');
  assert.equal(new ApplicationSkipMemory(dir).prior(job, 'owner-context'), undefined);
  next.remember(job, skip, 'owner-context');
  assert.ok(new ApplicationSkipMemory(dir).prior(job, 'owner-context'));
}));
