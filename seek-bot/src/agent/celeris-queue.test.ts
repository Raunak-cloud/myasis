import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

const directory = mkdtempSync(join(tmpdir(), 'celeris-client-queue-'));
Object.assign(process.env, { DATA_DIR: directory, COST_TRACKING: 'true', CELERIS_API_KEY: 'fixture-key',
  CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0', CELERIS_MAX_CONCURRENT_REQUESTS: '2' });
const { celerisChat, CostMeter, ApplicationBudgetExhaustedError } = await import('./celeris.js');
const { withApplicationModel } = await import('../application-model.js');
const originalFetch = globalThis.fetch, originalRandom = Math.random;
after(() => { globalThis.fetch = originalFetch; Math.random = originalRandom; closeCelerisQueues(); rmSync(directory, { recursive: true, force: true }); });
const request = { model: 'celeris-1' as const, messages: [{ role: 'user' as const, content: 'synthetic fixture' }], maxTokens: 256 };
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 3 } }));
const environment = (scope: string) => ({ ...process.env, CELERIS_WORKSPACE_ID: scope });

test('an unusable charged response cannot trigger another request after exhausting its application budget', async () => {
  let calls = 0;
  const meter = new CostMeter(0.50);
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: 'Incomplete response' }, finish_reason: 'length' }], usage: { completion_tokens: 1_000_000 } });
  };
  await assert.rejects(withApplicationModel(environment('budget-retry'), () => celerisChat({ ...request, meter })), ApplicationBudgetExhaustedError);
  assert.equal(calls, 1);
  assert.equal(meter.exhausted, true);
});

test('provider-reported charges on a format error also enforce the application budget before retrying', async () => {
  let calls = 0;
  const meter = new CostMeter(0.50);
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: 'response_format could not be satisfied', usage: { completion_tokens: 1_000_000 } }, { status: 400 });
  };
  await assert.rejects(withApplicationModel(environment('budget-format-retry'), () => celerisChat({ ...request, meter })), ApplicationBudgetExhaustedError);
  assert.equal(calls, 1);
  assert.equal(meter.exhausted, true);
});

test('429 honors Retry-After, jitter and a shared cooldown across accounts/models; payloads stay unchanged', async () => {
  Math.random = () => 0.5;
  const sent: Array<{ at: number; key: string; model: string }> = [];
  let throttled = false, notify!: () => void;
  const seen429 = new Promise<void>(resolve => { notify = resolve; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages, request.messages);
    assert.equal(body.max_tokens, 256);
    sent.push({ at: Date.now(), key: (init?.headers as Record<string,string>).authorization, model: body.model });
    if (!throttled) {
      throttled = true; notify();
      return new Response('{}', { status: 429, headers: { 'Retry-After': '0.2' } });
    }
    return success();
  };
  const one = withApplicationModel(environment('shared-429'), () => celerisChat(request));
  await seen429;
  // Let the response handler publish its cooldown before adding another account.
  await new Promise(resolve => setTimeout(resolve, 20));
  const two = withApplicationModel({ ...environment('shared-429'), CELERIS_API_KEY: 'rotated-fixture-key' },
    () => celerisChat({ ...request, model: 'celeris-1-magnus' }));
  await Promise.all([one, two]);
  assert.equal(sent.length, 3);
  assert.ok(sent[1].at - sent[0].at >= 550, 'neither retry nor other account may send before server delay plus jitter');
  assert.ok(sent.some(e => e.key === 'Bearer rotated-fixture-key' && e.model === 'celeris-1-magnus'));
  const ledger = readFileSync(join(directory, 'cost-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(ledger.some(e => e.amountUsd === 0 && e.basis === 'provider' && /HTTP 429/.test(e.detail)));
});

test('a Retry-After beyond the deadline stops immediately instead of retrying early', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }); };
  await assert.rejects(withApplicationModel(environment('long-delay'), () => celerisChat(request)), /deadline/);
  assert.equal(calls, 1);
});

test('transient HTTP failures retry with their delay; invalid requests are not blindly retried', async () => {
  let calls = 0, failedAt = 0, retriedAt = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) { failedAt = Date.now(); return new Response('{}', { status: 503, headers: { 'Retry-After': '0.1' } }); }
    retriedAt = Date.now(); return success();
  };
  await withApplicationModel(environment('service-busy'), () => celerisChat(request));
  assert.equal(calls, 2); assert.ok(retriedAt - failedAt >= 450);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Invalid schema: the string "503 timeout" is not allowed', { status: 400 }); };
  await assert.rejects(withApplicationModel(environment('invalid-request'), () => celerisChat(request)), /Celeris 400/);
  assert.equal(calls, 1);
});

test('queue rejection sends no request and creates no phantom unknown provider charge', async () => {
  const scope = 'full-fixture';
  const db = new DatabaseSync(process.env.CELERIS_QUEUE_FILE!);
  const insert = db.prepare("INSERT INTO celeris_requests(id,scope,state,expires,max_active,interval_ms) VALUES (?,?,'waiting',?,2,0)");
  for (let i=0;i<256;i++) insert.run(`full-${i}`, createHash('sha256').update(scope).digest('hex'), Date.now()+60_000);
  db.close();
  const before = readFileSync(join(directory, 'cost-ledger.jsonl'), 'utf8');
  let calls = 0; globalThis.fetch = async () => { calls++; return success(); };
  await assert.rejects(withApplicationModel(environment(scope), () => celerisChat(request)), /queue is full/);
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(directory, 'cost-ledger.jsonl'), 'utf8'), before);
});

test('a sent request timeout retains its cause when there is no time to retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new DOMException('Fixture provider timed out', 'TimeoutError'); };
  await assert.rejects(withApplicationModel(environment('sent-timeout'), () => celerisChat({ ...request, deadline: Date.now() + 300 })),
    error => /retry deadline reached.*provider timed out/.test(String(error)) && !/no new request was sent/.test(String(error)));
  assert.equal(calls, 1);
});

test('truncated generation followed by a timeout reports both failures instead of blaming queue admission', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 8192 } });
    throw new DOMException('Fixture provider timed out', 'TimeoutError');
  };
  await assert.rejects(withApplicationModel(environment('truncated-then-timeout'), () => celerisChat({ ...request, deadline: Date.now() + 300 })),
    error => /provider timed out/.test(String(error)) && /length limit/.test(String(error)) && !/no new request was sent/.test(String(error)));
  assert.equal(calls, 2);
});
