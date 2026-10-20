import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProgressiveTriage } from './progressive-triage.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'owtomate-progressive-ranking-'));
process.env.CELERIS_API_KEY = 'fixture-only';
const { rankJobsForReview } = await import('./llm.js');
const profile = { name: 'Fixture', phone: '', email: '', nationality: '', expectedSalary: '', noticePeriod: '',
  willingToRelocate: false, experienceSummary: 'Web development', skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };

test('only the first window incurs model calls; independent batches overlap and cache reuse is preserved', async () => {
  const original = globalThis.fetch;
  let calls = 0, active = 0, peak = 0;
  const releases: Array<() => void> = [];
  globalThis.fetch = async (_url, init) => {
    calls++; active++; peak = Math.max(peak, active);
    const body = JSON.parse(String(init?.body));
    const ids: string[] = body.response_format.json_schema.schema.properties.jobs.items.properties.reviewId.enum;
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ jobs: ids.map(reviewId => ({ reviewId, priority: 80, reason: 'Relevant fixture role' })) }) } }] }), { status: 200 });
  };
  try {
    const q = new ProgressiveTriage<{ id: string; title: string; company: string; location: string; url: string }>({
      key: job => job.id, group: () => 'employer', compare: () => 0,
    });
    q.add(Array.from({ length: 2000 }, (_, i) => ({ id: `fixture-${i}`, title: 'Developer', company: 'Fixture', location: 'Sydney', url: `https://fixture.invalid/${i}` })));
    const window = q.take();
    let settled = false;
    const work = rankJobsForReview(window, profile, { batchSize: 12, concurrency: 2 }).finally(() => { settled = true; });
    for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    assert.equal(peak, 2, 'ranking requests run concurrently, within the explicit ceiling');
    releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false, 'the operation owns and drains its second in-flight request');
    releases.shift()!();
    assert.equal((await work).size, 24);
    assert.equal(q.size, 1976);
    assert.equal(calls, 2, 'unneeded backlog never causes paid requests');
    assert.equal((await rankJobsForReview(window, profile, { batchSize: 12, concurrency: 2 })).size, 24);
    assert.equal(calls, 2, 'exact unchanged windows remain reusable');
  } finally {
    for (const release of releases) release();
    globalThis.fetch = original;
  }
});
