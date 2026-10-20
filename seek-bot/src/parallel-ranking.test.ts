import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeCelerisQueues } from '../../shared/celeris-queue.mjs';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-parallel-ranking-'));
Object.assign(process.env, {
  DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', APPLICATION_AI_MODEL: 'celeris',
  CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'),
  CELERIS_MIN_INTERVAL_MS: '0', CELERIS_MAX_CONCURRENT_REQUESTS: '2',
});
const { rankJobsForReview, reviewKey } = await import('./llm.js');
const { withApplicationModel } = await import('./application-model.js');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  closeCelerisQueues();
  rmSync(directory, { recursive: true, force: true });
});
const profile = { name: 'Fixture', phone: '', email: '', nationality: '', expectedSalary: '', noticePeriod: '',
  willingToRelocate: false, experienceSummary: 'Web development', skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };
const jobs = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, platform: 'indeed' as const, title: 'Developer', company: 'Fixture', location: 'Sydney',
  url: `https://fixture.invalid/${prefix}/${i}`,
}));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), 'expected ranking requests arrived');
}

function stub(haiku = false) {
  const calls: Array<{ ids: string[]; reply: (status?: number) => void }> = [];
  let active = 0, peak = 0, released = false;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const schema = haiku ? body.output_config.format.schema : body.response_format.json_schema.schema;
    const ids: string[] = schema.properties.jobs.items.properties.reviewId.enum;
    active++; peak = Math.max(peak, active);
    let reply!: (status?: number) => void;
    const status = await new Promise<number>(resolve => {
      reply = (value = 200) => resolve(value);
      calls.push({ ids, reply });
      if (released) reply();
    });
    active--;
    const content = JSON.stringify({
      jobs: ids.map(reviewId => ({ reviewId, priority: 80, reason: 'Relevant fixture role' })),
    });
    if (status !== 200) return new Response('{}', { status });
    return haiku ? Response.json({ content: [{ type: 'text', text: content }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 } })
      : Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  };
  return { calls, peak: () => peak, release: () => { released = true; calls.forEach(call => call.reply()); } };
}

test('production Celeris defaults overlap two unchanged batches, preserve order and reuse the exact cache', async () => {
  const fixture = stub(), listings = jobs('parallel', 65);
  let settled = false;
  const work = rankJobsForReview(listings, profile).finally(() => { settled = true; });
  try {
    await until(() => fixture.calls.length === 2);
    assert.deepEqual(fixture.calls.map(call => call.ids), [listings.slice(0, 20).map(reviewKey), listings.slice(20, 40).map(reviewKey)]);
    // Later batches finish first. A slow first request must not serialize the rest.
    fixture.calls[1].reply();
    await until(() => fixture.calls.length === 3);
    fixture.calls[2].reply();
    await until(() => fixture.calls.length === 4);
    fixture.calls[3].reply();
    await pause(20);
    assert.equal(settled, false, 'the first request is still owned and drained');
    fixture.calls[0].reply();
    const ranked = await work;
    assert.equal(fixture.peak(), 2);
    assert.deepEqual(fixture.calls.map(call => call.ids.length), [20, 20, 20, 5]);
    assert.deepEqual(fixture.calls.flatMap(call => call.ids), listings.map(reviewKey), 'each listing goes to one unchanged batch');
    assert.deepEqual([...ranked.keys()], listings.map(reviewKey), 'equal scores retain discovery order regardless of completion');
    assert.deepEqual(await rankJobsForReview(listings, profile, { concurrency: 1 }), ranked);
    assert.equal(fixture.calls.length, 4, 'scheduling does not invalidate reusable rankings');
  } finally { fixture.release(); await work.catch(() => {}); }
});

test('an outage stops new batches, drains the other request and keeps its valid results', async () => {
  const fixture = stub(), listings = jobs('outage', 65);
  let settled = false;
  const work = rankJobsForReview(listings, profile).finally(() => { settled = true; });
  try {
    await until(() => fixture.calls.length === 2);
    fixture.calls[0].reply(401);
    await pause(30);
    assert.equal(settled, false);
    assert.equal(fixture.calls.length, 2);
    fixture.calls[1].reply();
    assert.deepEqual([...(await work).keys()], listings.slice(20, 40).map(reviewKey));
    assert.equal(fixture.calls.length, 2, 'no pending tail is dispatched after an outage');
  } finally { fixture.release(); await work.catch(() => {}); }
});

test('parallel ranking obeys a lower workspace queue limit', async () => {
  const fixture = stub(), listings = jobs('limited', 41);
  const work = withApplicationModel({ ...process.env, CELERIS_MAX_CONCURRENT_REQUESTS: '1' },
    () => rankJobsForReview(listings, profile));
  try {
    await until(() => fixture.calls.length === 1);
    await pause(50);
    assert.equal(fixture.calls.length, 1, 'the other logical batch waits in the shared queue');
    for (let i = 0; i < 3; i++) {
      await until(() => fixture.calls.length === i + 1);
      fixture.calls[i].reply();
    }
    assert.equal((await work).size, 41);
    assert.equal(fixture.peak(), 1);
  } finally { fixture.release(); await work.catch(() => {}); }
});

test('Haiku keeps its existing sequential default and native request format', async () => {
  const fixture = stub(true), listings = jobs('haiku', 41);
  const work = withApplicationModel({ ...process.env, APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'fixture-only' },
    () => rankJobsForReview(listings, profile));
  try {
    await until(() => fixture.calls.length === 1);
    await pause(30);
    assert.equal(fixture.calls.length, 1);
    for (let i = 0; i < 3; i++) {
      await until(() => fixture.calls.length === i + 1);
      fixture.calls[i].reply();
    }
    assert.equal((await work).size, 41);
    assert.equal(fixture.peak(), 1);
  } finally { fixture.release(); await work.catch(() => {}); }
});
