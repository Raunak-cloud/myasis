import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targetedSeekRetryJobs, TARGET_RETRY_TRACE_MAX_BYTES, type TargetedSeekJob } from './targeted-retry-jobs.js';
import type { query } from './db/index.js';

const directories: string[] = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const id = '95593975', attemptId = '11111111-1111-4111-8111-111111111111';
const run = { id: '1145', user_id: '183', finished_at: '2026-11-02T17:45:00Z' };
function sourceTrace() {
  return { jobId: id, title: 'Data Analyst', company: 'Fixture Employer',
    job: { id, title: 'Data Analyst', company: 'Fixture Employer', platform: 'seek', url: `https://www.seek.com.au/job/${id}`, fitReview: { decision: 'old-do-not-reuse' } },
    runStartId: run.id, attemptId, mode: 'prepare', outcome: { status: 'skipped', reason: 'Fixture tooling error before any send.' },
    steps: [{ step: 1, tool: 'take_snapshot', args: {}, label: 'Inspect current page', execution: 'started', completedAt: '2026-11-02T17:40:00Z' }],
    sendAudit: { attempted: false }, savedAt: '2026-11-02T17:41:00Z' };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'targeted-retry-evidence-')); directories.push(directory);
  const owner = join(directory, '183'); mkdirSync(join(owner, 'traces'), { recursive: true });
  const alias = join(owner, 'traces', `${id}.json`), immutable = join(owner, 'traces', `attempt-${attemptId}.json`);
  let events: TargetedSeekJob[] = [], sourceRun: typeof run | null = { ...run }, sourceReads = 0;
  const write = (trace: unknown = sourceTrace()) => { writeFileSync(alias, JSON.stringify(trace)); copyFileSync(alias, immutable); };
  write();
  const deps = { directory: (ownerId: string) => { assert.equal(ownerId, '183'); return owner; },
    query: (async (sql: string, params: unknown[]) => {
      assert.equal(params[0], '183', 'every database lookup stays bound to this owner');
      if (sql.includes('FROM run_events')) return events;
      assert.match(sql, /FROM run_starts WHERE user_id=\$1 AND id=\$2 AND finished_at IS NOT NULL/);
      assert.equal(params[1], '1145'); sourceReads++; return sourceRun ? [sourceRun] : [];
    }) as typeof query };
  return { owner, alias, immutable, deps, write,
    events: (value: TargetedSeekJob[]) => { events = value; }, sourceRun: (value: typeof run | null) => { sourceRun = value; }, sourceReads: () => sourceReads };
}

test('retained owner-bound no-send attempt supplies metadata only when event metadata is missing', async () => {
  const f = fixture(), before = readFileSync(f.alias);
  const result = await targetedSeekRetryJobs('183', [id], f.deps);
  assert.deepEqual(result, [{ job_id: id, title: 'Data Analyst', company: 'Fixture Employer' }]);
  assert.deepEqual(Object.keys(result![0]).sort(), ['company', 'job_id', 'title']);
  assert.deepEqual(readFileSync(f.alias), before, 'lookup never rewrites source history or provenance');
  assert.equal(f.sourceReads(), 1);
});
test('existing event metadata takes precedence without opening a trace directory', async () => {
  const f = fixture(); f.events([{ job_id: id, title: 'Current Event Title', company: 'Current Event Employer' }]);
  f.deps.directory = () => { throw Error('No trace fallback is needed.'); };
  assert.deepEqual(await targetedSeekRetryJobs('183', [id], f.deps), [{ job_id: id, title: 'Current Event Title', company: 'Current Event Employer' }]);
  assert.equal(f.sourceReads(), 0);
});
test('mixed event and retained sources preserve requested order and never infer an unknown job', async () => {
  const f = fixture(); f.events([{ job_id: '95530570', title: 'Event job', company: 'Event employer' }]);
  assert.deepEqual((await targetedSeekRetryJobs('183', ['95530570', id], f.deps))?.map(job => job.job_id), ['95530570', id]);
  assert.equal(await targetedSeekRetryJobs('183', ['99999999'], f.deps), null);
});
test('only the exact finished database-owned run may bind retained evidence', async () => {
  const f = fixture();
  for (const source of [null, { ...run, user_id: '184' }, { ...run, id: '1144' }, { ...run, finished_at: null }, { ...run, finished_at: 'invalid' }]) {
    f.sourceRun(source as typeof run | null);
    assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  }
});
test('foreign platform, job identity, URL, title and run bindings fail closed', async () => {
  const patches: Array<(trace: ReturnType<typeof sourceTrace>) => void> = [
    t => { t.jobId = '95530570'; }, t => { t.job.id = '95530570'; }, t => { t.job.platform = 'indeed'; },
    t => { t.job.url = `https://indeed.com/job/${id}`; }, t => { t.job.url = `https://seek.com.au.attacker.invalid/job/${id}`; },
    t => { t.job.url = `https://www.seek.com.au/job/95530570`; }, t => { t.job.url = `http://www.seek.com.au/job/${id}`; },
    t => { t.job.url = `https://candidate:private@www.seek.com.au/job/${id}`; }, t => { t.job.url = `https://www.seek.com.au:8443/job/${id}`; },
    t => { t.job.title = 'Different title'; }, t => { t.company = 'Different employer'; }, t => { t.job.company = ''; },
    t => { t.runStartId = '../1145'; }, t => { t.attemptId = '../../other'; },
  ];
  for (const patch of patches) { const f = fixture(), trace = sourceTrace(); patch(trace); f.write(trace); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null); }
});
test('confirmed, pending or uncertain sends cannot become retry metadata', async () => {
  const patches: Array<(trace: any) => void> = [
    t => { t.outcome.status = 'applied'; }, t => { t.outcome.status = 'prepared'; }, t => { delete t.outcome; },
    t => { t.sendAudit.attempted = true; }, t => { delete t.sendAudit; }, t => { delete t.steps[0].completedAt; },
    t => { t.steps.push({ completedAt: '2026-11-02T17:40:00Z', tool: 'browser_action', args: { action: 'click', sends_application: true }, label: 'Send' }); },
  ];
  for (const patch of patches) { const f = fixture(), trace = sourceTrace(); patch(trace); f.write(trace); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null); }
});
test('latest live pointer cannot hide a newer interrupted attempt behind an older safe terminal', async () => {
  const f = fixture(), live = sourceTrace();
  const path = join(f.owner, 'traces', `${id}.live.json`);
  writeFileSync(path, JSON.stringify({ ...live, outcome: undefined, status: 'in-progress' }));
  assert.ok(await targetedSeekRetryJobs('183', [id], f.deps), 'same-attempt live snapshot is superseded by its exact terminal record');
  live.attemptId = '22222222-2222-4222-8222-222222222222';
  writeFileSync(path, JSON.stringify(live));
  assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null, 'never scan backwards for a convenient no-send proof');
});
test('corrupt, oversized or mismatched immutable evidence is rejected', async () => {
  const f = fixture();
  writeFileSync(f.alias, '{partial'); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  f.write(); writeFileSync(f.immutable, '{partial'); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  f.write(); writeFileSync(f.immutable, JSON.stringify({ ...sourceTrace(), savedAt: '2026-11-02T17:42:00Z' }));
  assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  f.write(); truncateSync(f.alias, TARGET_RETRY_TRACE_MAX_BYTES + 1); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  f.write(); truncateSync(f.immutable, TARGET_RETRY_TRACE_MAX_BYTES + 1); assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
});
test('alias replacement during database verification is rejected', async () => {
  const f = fixture(), original = f.deps.query;
  f.deps.query = (async (sql: string, params: unknown[]) => {
    const result = await original(sql, params);
    if (sql.includes('FROM run_starts')) writeFileSync(f.alias, JSON.stringify({ ...sourceTrace(), savedAt: '2026-11-02T17:42:00Z' }));
    return result;
  }) as typeof query;
  assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
});
test('symlinked parent directories cannot redirect evidence to another owner', async () => {
  const f = fixture(), foreign = fixture();
  rmSync(join(f.owner, 'traces'), { recursive: true });
  symlinkSync(join(foreign.owner, 'traces'), join(f.owner, 'traces'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
  const rootLink = join(f.owner, 'linked-owner');
  symlinkSync(foreign.owner, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  f.deps.directory = () => rootLink;
  assert.equal(await targetedSeekRetryJobs('183', [id], f.deps), null);
});
test('caller-controlled path fragments are refused before any database or filesystem lookup', async () => {
  const f = fixture(); f.deps.query = (async () => { throw Error('Invalid identifiers must not reach database.'); }) as typeof query;
  for (const [owner, jobs] of [['../183', [id]], ['183', ['../95593975']], ['183', []], ['183', ['not-a-seek-id']]] as const)
    assert.equal(await targetedSeekRetryJobs(owner, [...jobs], f.deps), null);
});
