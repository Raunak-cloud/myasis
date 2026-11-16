import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPublicVacancyEvidence } from './public-evidence.js';

const now = new Date('2026-11-16T08:00:00.000Z');
const appliedAt = '2026-11-16T06:15:00.000Z';
const job = { user_id: '1', source_run_id: '1387', job_id: '95636932', platform: 'seek', title: 'Software Engineer',
  company: 'Example Insurance Brokers (Australia)', url: 'https://www.seek.com.au/job/95636932', location: 'Sydney NSW', applied_at: appliedAt };
function row(overrides: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
  return { ts: appliedAt, status: 'applied', jobId: job.job_id, technicalAttempt: { runId: '1387', job: {
    id: job.job_id, platform: job.platform, title: job.title, company: job.company, url: job.url,
    description: 'Public vacancy. Contact our Human Resources team at ••••@example.org.', location: 'Sydney NSW', ...snapshot,
  } }, ...overrides };
}
async function fixture(action: (directory: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'hr-public-evidence-')), directory = join(root, '1');
  await mkdir(directory);
  try { await action(directory, root); } finally { await rm(root, { recursive: true, force: true }); }
}
const options = (directory: string) => ({ directory, now: () => new Date(now) });
const writeRows = (directory: string, name: string, rows: unknown[]) => writeFile(join(directory, name), rows.map(v => JSON.stringify(v)).join('\n') + '\n', 'utf8');

test('exact current-run evidence is preferred and projects public vacancy fields only', async () => fixture(async directory => {
  const current = row({ coverLetter: 'PRIVATE_CANDIDATE_LETTER', answers: [{ value: 'PRIVATE_ANSWER' }], resume: 'PRIVATE_RESUME', notes: 'PRIVATE_AGENT_NOTES' },
    { candidate: 'PRIVATE_PROFILE', ignored: 'PRIVATE_EXTRA_FIELD' });
  await writeRows(directory, 'run-log.jsonl', [current]);
  const archive = row({ ts: '2026-11-16T06:16:00Z' }, { description: 'A later unrelated archive version.' });
  await writeRows(directory, 'application-outcomes.jsonl', [archive]);
  const result = await loadPublicVacancyEvidence(job, options(directory));
  assert.deepEqual(result, { description: current.technicalAttempt.job.description, location: 'Sydney NSW', sourceUrl: job.url,
    observedAt: appliedAt, sourceKind: 'stored_vacancy' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|candidate|answers|resume|coverLetter|technicalAttempt/i);
}));

test('the latest valid exact observation wins inside the current run, irrespective of file order', async () => fixture(async directory => {
  await writeRows(directory, 'run-log.jsonl', [row({ ts: '2026-11-16T06:17:00Z' }, { description: 'Newest public description.' }),
    row({ ts: '2026-11-16T06:16:00Z' }, { description: 'Older public description.' }), row({ ts: '2026-11-16T06:18:00Z', technicalAttempt: { runId: '1386', job: row().technicalAttempt.job } })]);
  const result = await loadPublicVacancyEvidence(job, options(directory));
  assert.equal(result?.description, 'Newest public description.');
  assert.equal(result?.observedAt, '2026-11-16T06:17:00.000Z');
}));

test('a missing-run archive can restore exact listing evidence only within the application window', async () => fixture(async directory => {
  const archived = row({ ts: '2026-11-16T06:14:00Z' }); delete (archived.technicalAttempt as { runId?: string }).runId;
  await writeRows(directory, 'run-log.jsonl', [row({ technicalAttempt: { runId: '1386', job: row().technicalAttempt.job } })]);
  await writeRows(directory, 'application-outcomes.jsonl', [archived]);
  const result = await loadPublicVacancyEvidence(job, options(directory));
  assert.equal(result?.sourceKind, 'stored_vacancy');
  assert.equal(result?.observedAt, '2026-11-16T06:14:00.000Z');
  assert.notEqual(result?.observedAt, now.toISOString(), 'loading old source evidence never renews its observation time');
  for (const ts of ['2026-11-15T06:14:59.999Z', '2026-11-16T06:20:00.001Z']) {
    await writeRows(directory, 'application-outcomes.jsonl', [{ ...archived, ts }]);
    assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  }
}));

test('missing archive application time and explicit wrong archive run never authorize fallback', async () => fixture(async directory => {
  const archived = row(); delete (archived.technicalAttempt as { runId?: string }).runId;
  await writeRows(directory, 'application-outcomes.jsonl', [archived]);
  assert.equal(await loadPublicVacancyEvidence({ ...job, applied_at: undefined }, options(directory)), null);
  await writeRows(directory, 'application-outcomes.jsonl', [row({ technicalAttempt: { runId: '1386', job: row().technicalAttempt.job } })]);
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
}));

test('source evidence is owner-isolated and rejects explicit foreign-owner metadata', async () => fixture(async (directory, root) => {
  await writeRows(directory, 'run-log.jsonl', [row({ user_id: '2' }), row({ userId: '2' }), row({}, { user_id: '2' })]);
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  const second = join(root, '2'); await mkdir(second); await writeRows(second, 'run-log.jsonl', [row()]);
  await writeRows(directory, 'run-log.jsonl', []);
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null, 'another account directory is never searched');
  let reads = 0;
  for (const user_id of ['../2', '0', '-1', '1/../../2', '999999999999999999999']) {
    const result = await loadPublicVacancyEvidence({ ...job, user_id }, { get directory() { reads++; return second; }, now: () => new Date(now) });
    assert.equal(result, null);
  }
  assert.equal(reads, 0, 'invalid owner IDs are rejected before directory access');
}));

test('job ID, platform, company, title and listing URL must all match independently', async () => fixture(async directory => {
  const invalid = [row({ jobId: 'other' }), row({}, { id: 'other' }), row({}, { platform: 'indeed' }), row({}, { company: 'Another Employer' }),
    row({}, { title: 'Another Role' }), row({}, { url: 'https://www.seek.com.au/job/99999999' }),
    row({}, { url: 'https://seek.com.au.evil.example/job/95636932' }), row({ status: 'prepared' }),
    row({ technicalAttempt: { runId: '1386', job: row().technicalAttempt.job } })];
  for (const item of invalid) {
    await writeRows(directory, 'run-log.jsonl', [item]);
    assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  }
}));

test('SEEK aliases and tracking variants retain the exact vacancy identity', async () => fixture(async directory => {
  await writeRows(directory, 'run-log.jsonl', [row({}, { url: 'https://au.seek.com/job/95636932?utm_source=board&seek-token=PRIVATE_TOKEN', title: ' Software  Engineer ', company: 'EXAMPLE INSURANCE BROKERS (AUSTRALIA)' })]);
  const result = await loadPublicVacancyEvidence(job, options(directory));
  assert.equal(result?.sourceUrl, 'https://www.seek.com.au/job/95636932');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|seek-token|utm_/);
}));

test('Indeed jk and vjk aliases match while different vacancy keys do not', async () => fixture(async directory => {
  const indeed = { ...job, platform: 'indeed', job_id: 'a84669c79d5f1353', url: 'https://au.indeed.com/viewjob?jk=a84669c79d5f1353' };
  const item = row({ jobId: indeed.job_id }, { id: indeed.job_id, platform: 'indeed', url: 'https://www.indeed.com/jobs?q=software&vjk=a84669c79d5f1353' });
  await writeRows(directory, 'run-log.jsonl', [item]);
  assert.equal((await loadPublicVacancyEvidence(indeed, options(directory)))?.sourceUrl, indeed.url);
  item.technicalAttempt.job.url = 'https://au.indeed.com/viewjob?jk=b84669c79d5f1353';
  await writeRows(directory, 'run-log.jsonl', [item]);
  assert.equal(await loadPublicVacancyEvidence(indeed, options(directory)), null);
}));

test('non-board URL matching preserves vacancy routing parameters and removes tracking only', async () => fixture(async directory => {
  const external = { ...job, platform: 'workday', job_id: 'req-123', url: 'https://employer.org/careers?jobId=123&tenant=AU' };
  const item = row({ jobId: external.job_id }, { id: external.job_id, platform: external.platform, url: 'https://www.employer.org/careers?utm_source=test&tenant=AU&jobId=123' });
  await writeRows(directory, 'run-log.jsonl', [item]);
  assert.ok(await loadPublicVacancyEvidence(external, options(directory)));
  item.technicalAttempt.job.url = 'https://employer.org/careers?jobId=124&tenant=AU';
  await writeRows(directory, 'run-log.jsonl', [item]);
  assert.equal(await loadPublicVacancyEvidence(external, options(directory)), null);
}));

test('stale, future and malformed timestamps cannot be claimed as current evidence', async () => fixture(async directory => {
  for (const ts of ['2026-10-16T07:59:59.999Z', '2026-11-16T08:00:00.001Z', 'not-a-time']) {
    await writeRows(directory, 'run-log.jsonl', [row({ ts })]);
    assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  }
  await writeRows(directory, 'run-log.jsonl', [row({ ts: '2026-10-16T08:00:00.000Z' })]);
  assert.equal((await loadPublicVacancyEvidence(job, options(directory)))?.observedAt, '2026-10-16T08:00:00.000Z');
}));

test('one-calendar-month retention clamps month end, including leap years', async () => fixture(async directory => {
  const leapNow = new Date('2024-03-31T08:00:00Z');
  await writeRows(directory, 'run-log.jsonl', [row({ ts: '2024-02-29T08:00:00Z' })]);
  assert.ok(await loadPublicVacancyEvidence(job, { directory, now: () => leapNow }));
  await writeRows(directory, 'run-log.jsonl', [row({ ts: '2024-02-29T07:59:59.999Z' })]);
  assert.equal(await loadPublicVacancyEvidence(job, { directory, now: () => leapNow }), null);
}));

test('malformed and oversized JSONL records are skipped without losing a later valid snapshot', async () => fixture(async directory => {
  const valid = row({}, { description: 'Valid public description after malformed data.' });
  await writeFile(join(directory, 'run-log.jsonl'), '{broken json}\n' + JSON.stringify(row({}, { description: 'x'.repeat(600_000) })) + '\n' + JSON.stringify(valid) + '\n{partial', 'utf8');
  assert.equal((await loadPublicVacancyEvidence(job, options(directory)))?.description, valid.technicalAttempt.job.description);
  await writeRows(directory, 'run-log.jsonl', [row({}, { description: 'x'.repeat(125_000) })]);
  assert.equal((await loadPublicVacancyEvidence(job, options(directory)))?.description.length, 120_000);
}));

test('a bounded tail finds recent evidence after a very large older record', async () => fixture(async directory => {
  await writeFile(join(directory, 'application-outcomes.jsonl'), 'x'.repeat(17 * 1024 * 1024) + '\n' + JSON.stringify(row()) + '\n', 'utf8');
  assert.equal((await loadPublicVacancyEvidence(job, options(directory)))?.observedAt, appliedAt);
}));

test('missing, unsafe or unavailable files and absent public description return null', async () => fixture(async directory => {
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  await mkdir(join(directory, 'run-log.jsonl'));
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  await rm(join(directory, 'run-log.jsonl'), { recursive: true });
  await writeRows(directory, 'run-log.jsonl', [row({}, { description: '' }), row({}, { description: undefined })]);
  assert.equal(await loadPublicVacancyEvidence(job, options(directory)), null);
  assert.equal(await loadPublicVacancyEvidence({ ...job, url: 'file:///private/profile.txt' }, options(directory)), null);
  for (const url of ['https://127.0.0.1/job/95636932', 'https://localhost/job/95636932', 'https://private.internal/job/95636932', 'https://user:password@seek.com.au/job/95636932', 'https://www.seek.com.au/job/11111111']) {
    assert.equal(await loadPublicVacancyEvidence({ ...job, url }, options(directory)), null);
  }
  assert.equal(await loadPublicVacancyEvidence({ ...job, source_run_id: '../other-run' }, options(directory)), null);
}));
