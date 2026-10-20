import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCelerisPermit, closeCelerisQueues } from '../../shared/celeris-queue.mjs';
import { askCelerisForJson } from './search-terms.js';
import { getPool } from './db/index.js';

const dir = mkdtempSync(join(tmpdir(), 'dashboard-celeris-queue-'));
const names = ['CELERIS_QUEUE_FILE', 'CELERIS_WORKSPACE_ID', 'CELERIS_MIN_INTERVAL_MS', 'CELERIS_MAX_CONCURRENT_REQUESTS', 'CELERIS_BASE_URL'] as const;
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
Object.assign(process.env, { CELERIS_QUEUE_FILE: join(dir, 'queue.sqlite'), CELERIS_WORKSPACE_ID: 'dashboard-fixture',
  CELERIS_MIN_INTERVAL_MS: '0', CELERIS_MAX_CONCURRENT_REQUESTS: '1', CELERIS_BASE_URL: 'https://fixture.celeris.invalid' });
const originalFetch = globalThis.fetch, originalRandom = Math.random;
after(async () => {
  globalThis.fetch = originalFetch; Math.random = originalRandom;
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  closeCelerisQueues(); rmSync(dir, { recursive: true, force: true }); await getPool().end();
});
const call = () => askCelerisForJson('fixture-key', 'extract', 'synthetic fixture', { type: 'object', properties: { terms: { type: 'array', items: { type: 'string' } } } }, 0, {});
const success = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"terms":["Developer"]}' } }] }));

test('dashboard helpers wait for application workers instead of creating a separate allowance', async () => {
  const permit = await acquireCelerisPermit({ endpoint: process.env.CELERIS_BASE_URL!, deadline: Date.now()+5000 });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'celeris-1-magnus');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.max_tokens, 16_384);
    return success();
  };
  const pending = call();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls, 0);
  permit.release();
  assert.deepEqual(await pending, { ok: true, value: { terms: ['Developer'] } });
  assert.equal(calls, 1);
});

test('dashboard retries temporary failures with Retry-After, while invalid requests return directly', async () => {
  Math.random = () => 0;
  let calls = 0, first = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) { first = Date.now(); return new Response('{}', { status: 429, headers: { 'Retry-After': '0.2' } }); }
    assert.ok(Date.now() - first >= 200);
    return success();
  };
  assert.equal((await call()).ok, true); assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('invalid schema', { status: 400 }); };
  assert.equal((await call()).ok, false); assert.equal(calls, 1);
});

test('dashboard never retries sooner when Retry-After exceeds its entire request deadline', async () => {
  process.env.CELERIS_WORKSPACE_ID = 'dashboard-long-delay';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 503, headers: { 'Retry-After': '300' } }); };
  const result = await call();
  assert.equal(result.ok, false); assert.match(result.error!, /deadline/); assert.equal(calls, 1);
});
