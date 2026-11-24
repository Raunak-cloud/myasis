import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicEmployerTarget, publicEmployerTargets } from './public-employer-directory.js';
import { publicEmployerSearchCache } from './public-employer-search-cache.js';
test('Greenhouse retains public board tokens across hosted boards, job pages and the jobs API', () => {
  assert.equal(publicEmployerTarget('https://job-boards.greenhouse.io/fixture/jobs/123?source=fixture#application'), 'fixture');
  assert.equal(publicEmployerTarget('https://boards.greenhouse.io/fixture/'), 'fixture');
  assert.equal(publicEmployerTarget('https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true'), 'fixture');
  for (const bad of [
    'https://job-boards.greenhouse.io.evil.invalid/fixture/jobs/123',
    'https://boards.greenhouse.io/fixture/jobs/login',
    'https://boards.greenhouse.io/login',
    'https://boards.greenhouse.io/embed/job_board?for=fixture',
    'https://boards-api.greenhouse.io/v1/boards/fixture/applications',
    'https://user:secret@boards.greenhouse.io/fixture',
  ]) assert.equal(publicEmployerTarget(bad), null);
  assert.deepEqual(publicEmployerTargets(['Fixture', 'fixture', 'https://boards.greenhouse.io/fixture/jobs/123']), ['Fixture']);
});

test('Greenhouse board snapshots stop at the byte limit without draining or caching an oversized response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenhouse-board-cache-'));
  try {
    let sent = 0, cancelled = 0;
    const chunk = new Uint8Array(1_000_000);
    const network: typeof fetch = async () => new Response(new ReadableStream({
      pull(controller) { sent++; controller.enqueue(chunk); },
      cancel() { cancelled++; },
    }));
    await assert.rejects(publicEmployerSearchCache(dir, network)('https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true'), /exceeded size limit/);
    assert.equal(cancelled, 1);
    assert.ok(sent >= 9 && sent <= 10, 'stream stops as soon as the limit is crossed');
    assert.deepEqual(await publicEmployerSearchCache(dir, async () => Response.json({ jobs: ['fresh'] }))('https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true').then(response => response.json()), { jobs: ['fresh'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('Greenhouse shares fresh public snapshots and reads details and errors live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenhouse-board-cache-'));
  try {
    let calls = 0, now = 10_000_000;
    const network: typeof fetch = async () => { calls++; return Response.json({ jobs: [] }); };
    const cache = publicEmployerSearchCache(dir, network, () => now);
    const board = 'https://boards-api.greenhouse.io/v1/boards/fixture/jobs';
    const snapshot = board + '?content=true';
    await cache(snapshot);
    await cache(snapshot);
    assert.equal(calls, 1);
    await cache(snapshot, { headers: { Authorization: 'fixture-only' } });
    for (let i = 0; i < 2; i++) await cache(board + '/123?content=true');
    assert.equal(calls, 4);
    now += 31 * 60_000;
    await cache(snapshot);
    assert.equal(calls, 5);
    let failures = 0;
    const fail = publicEmployerSearchCache(dir, async () => { failures++; return new Response('', { status: 429 }); });
    for (let i = 0; i < 2; i++) await fail(snapshot.replace('/fixture/', '/uncached/'));
    assert.equal(failures, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
