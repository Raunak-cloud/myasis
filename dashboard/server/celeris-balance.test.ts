import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createCelerisBalanceReader } from './celeris-balance.js';
import { applicationRunEnvironment } from './runner.js';
import { getPool } from './db/index.js';

after(async () => { await getPool().end(); });
const env = { CELERIS_MANAGEMENT_TOKEN: 'cmt_fixture', CELERIS_BILLING_WORKSPACE_ID: 'ws_fixture', CELERIS_API_KEY: 'ck_do_not_use' };
const provider = (cents: number) => ({ account: { email: 'private@fixture.invalid' }, workspace: { id: 'ws_fixture', name: 'Myasis' }, balance: { creditBalanceCents: cents, currency: 'usd' } });

test('reads real prepaid credit, coalesces calls, preserves zero and never exposes account data or credentials', async () => {
  let calls = 0;
  const read = createCelerisBalanceReader(() => env, async (url, options) => {
    calls++; assert.equal(url, 'https://console.celeris.ai/api/agent/context');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer cmt_fixture' });
    assert.equal(options?.redirect, 'error');
    return Response.json(provider(0));
  });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  assert.equal(a.status, 'ready'); assert.equal(a.creditBalanceCents, 0); assert.equal(a.currency, 'USD');
  assert.doesNotMatch(JSON.stringify(a), /cmt_|ck_|private@/);
  await read(); assert.equal(calls, 1);
  assert.equal(applicationRunEnvironment(env).CELERIS_MANAGEMENT_TOKEN, undefined);
});

test('rejects the wrong workspace and missing balance, and handles revoked access without inventing zero', async () => {
  const cases = [
    Response.json({ ...provider(3527), workspace: { id: 'wrong' } }),
    Response.json({ ...provider(3527), balance: { currency: 'usd' } }),
    new Response('{}', { status: 401 }),
  ];
  for (const response of cases) {
    const result = await createCelerisBalanceReader(() => env, async () => response)();
    assert.notEqual(result.status, 'ready'); assert.equal(result.creditBalanceCents, undefined);
  }
  const result = await createCelerisBalanceReader(() => ({}), async () => { throw Error('Must not call without credentials'); })();
  assert.equal(result.status, 'disconnected');
});
