import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-assessment-reuse-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { config } = await import('./config.js');
const { applicationModelIdentity, withApplicationModel } = await import('./application-model.js');
const { cachedAssessment } = await import('./pipeline.js');
const { rankJobsForReview } = await import('./llm.js');
const originalFetch = globalThis.fetch;
const profile = { name: 'Fixture', phone: '', email: 'fixture@example.test', nationality: '', expectedSalary: '',
  noticePeriod: '', willingToRelocate: false, experienceSummary: 'Web development', skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };
const jobs = [
  { id: 'one', title: 'Developer', company: 'Fixture One', location: 'Sydney', url: 'https://fixture.invalid/one', teaser: 'Build web tools.' },
  { id: 'two', title: 'Engineer', company: 'Fixture Two', location: 'Sydney', url: 'https://fixture.invalid/two', teaser: 'Build software.' },
];
let calls = 0;
let malformed: 'none' | 'missing' | 'duplicate' | 'foreign' | 'score' = 'none';
globalThis.fetch = async (_url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  const schema = body.response_format.json_schema.schema;
  let value: unknown;
  if (schema.properties.jobs) {
    const ids: string[] = schema.properties.jobs.items.properties.reviewId.enum;
    const ranked = ids.map((reviewId, index) => ({ reviewId, priority: 90 - index, reason: 'Fixture ranking' }));
    if (malformed === 'missing') ranked.pop();
    if (malformed === 'duplicate') ranked[1] = { ...ranked[0] };
    if (malformed === 'foreign') ranked[0].reviewId = 'seek:foreign';
    if (malformed === 'score') ranked[0].priority = 101;
    value = { jobs: ranked };
  } else throw Error('Only ranking requests are expected by this fixture.');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
};

try {
  let computes = 0;
  const compute = async () => { computes++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, result: 'unchanged' }; };
  const accept = (value: { ok: boolean }) => value?.ok === true;
  const results = await Promise.all(Array.from({ length: 50 }, () => cachedAssessment({ fixture: 'concurrent' }, compute, accept)));
  assert.equal(computes, 1, '50 concurrent identical requests pay for one computation');
  assert.ok(results.every(value => value.result === 'unchanged'));
  await cachedAssessment({ fixture: 'concurrent' }, compute, accept);
  assert.equal(computes, 1, 'completed work persists for later requests');

  // Demonstrate reuse after process restart, without any provider credentials.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {cachedAssessment}=await import(${JSON.stringify(new URL('./pipeline.js', import.meta.url).href)});
    const value=await cachedAssessment({fixture:'concurrent'},async()=>{throw new Error('cache miss after restart')},v=>v?.ok===true);
    if(value.result!=='unchanged')process.exit(1);
  `], { env: { ...process.env, CELERIS_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const firstOwner = cachedAssessment({ fixture: 'owners' }, compute, accept);
  const secondOwner = withApplicationModel({ ...process.env, DATA_DIR: join(directory, 'second-owner') },
    () => cachedAssessment({ fixture: 'owners' }, compute, accept));
  await Promise.all([firstOwner, secondOwner]);
  assert.equal(computes, 3, 'same inputs from separate accounts never share in-flight work');

  let failures = 0;
  const fail = async () => { failures++; await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('fixture outage'); };
  const rejected = await Promise.allSettled(Array.from({ length: 10 }, () => cachedAssessment({ fixture: 'outage' }, fail, () => true)));
  assert.equal(failures, 1);
  assert.ok(rejected.every(value => value.status === 'rejected'));
  await assert.rejects(cachedAssessment({ fixture: 'outage' }, fail, () => true), /fixture outage/);
  assert.equal(failures, 2, 'rejection releases in-flight entry; later request retries normally');

  let invalids = 0;
  for (let i = 0; i < 2; i++) await cachedAssessment({ fixture: 'invalid' }, async () => ({ ok: false, count: ++invalids }), accept);
  assert.equal(invalids, 2, 'unvalidated outputs never persist');
  const fixturePath = (input: unknown) => resolve(directory, 'fit-cache', `${createHash('sha256').update(JSON.stringify({ applicationModel: applicationModelIdentity(), input })).digest('hex')}.json`);
  for (const [fixture, at] of [['expired', Date.now() - 2000], ['future', Date.now() + 60_000]] as const) {
    writeFileSync(fixturePath({ fixture }), JSON.stringify({ at, value: { ok: true, result: 'stale' } }));
    const value = await cachedAssessment({ fixture }, compute, accept, 1000);
    assert.equal(value.result, 'unchanged', `${fixture} cache must be recomputed`);
  }
  writeFileSync(fixturePath({ fixture: 'corrupt' }), '{broken JSON');
  assert.equal((await cachedAssessment({ fixture: 'corrupt' }, compute, accept)).result, 'unchanged');
  mkdirSync(join(directory, 'blocked-owner'), { recursive: true });
  writeFileSync(join(directory, 'blocked-owner', 'fit-cache'), 'not a directory');
  const uncached = await withApplicationModel({ ...process.env, DATA_DIR: join(directory, 'blocked-owner') },
    () => cachedAssessment({ fixture: 'unwritable' }, compute, accept));
  assert.equal(uncached.result, 'unchanged', 'cache write failures do not strand a job');

  const before = calls;
  const original = await rankJobsForReview(jobs, profile);
  assert.deepEqual(await rankJobsForReview(jobs, profile), original);
  assert.equal(calls - before, 1, 'repeat exact ranking is free and preserves the model result');
  await rankJobsForReview(jobs, { ...profile, skills: ['Python'] });
  await rankJobsForReview([...jobs].reverse(), profile);
  await rankJobsForReview([{ ...jobs[0], salary: '$120,000' }, jobs[1]], profile);
  await rankJobsForReview([{ ...jobs[0], location: 'Perth' }, jobs[1]], profile);
  await rankJobsForReview([{ ...jobs[0], teaser: 'Different duties' }, jobs[1]], profile);
  assert.equal(calls - before, 6, 'changed facts, listing content or batch order must reach the model');
  config.aiInstructions = 'Avoid manager roles.';
  await rankJobsForReview(jobs, profile);
  config.keywords = ['AI engineering'];
  await rankJobsForReview(jobs, profile);
  config.rules.minSalary += 1;
  await rankJobsForReview(jobs, profile);
  const oldEndpoint = config.celeris.baseUrl;
  config.celeris.baseUrl += '/fixture';
  await rankJobsForReview(jobs, profile);
  config.celeris.baseUrl = oldEndpoint;
  writeFileSync(join(directory, 'review-history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), jobId: jobs[0].id, title: jobs[0].title, company: jobs[0].company, status: 'skipped', reason: 'New history evidence' }) + '\n');
  await rankJobsForReview(jobs, profile);
  assert.equal(calls - before, 11, 'instructions, search, constraints, endpoint and history invalidate reuse');
  await withApplicationModel({ ...process.env, DATA_DIR: join(directory, 'ranking-other-owner') },
    () => rankJobsForReview(jobs, profile));
  assert.equal(calls - before, 12);

  for (const kind of ['missing', 'duplicate', 'foreign', 'score'] as const) {
    malformed = kind;
    const changed = jobs.map(job => ({ ...job, id: `${job.id}-${kind}` }));
    const count = calls;
    await rankJobsForReview(changed, profile);
    await rankJobsForReview(changed, profile);
    assert.equal(calls - count, 2, `${kind} rankings must not be cached`);
  }
  malformed = 'none';
  const metrics = readFileSync(join(directory, 'pipeline-metrics.jsonl'), 'utf8');
  assert.match(metrics, /assessment-inflight-hit/);
  assert.match(metrics, /fit-cache-hit/);
  console.log('PASS: single-flight 50→1, restart reuse, owner isolation, expiration, failed/invalid replies, write failure, exact ranking reuse and all context invalidations (no live model calls)');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-assessment-reuse-'));
  rmSync(directory, { recursive: true, force: true });
}
