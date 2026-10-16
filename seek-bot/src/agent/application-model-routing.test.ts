/** Celeris transport and account-scope regression. No model/network calls. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'celeris-routing-fixture-'));
Object.assign(process.env, { DATA_DIR: directory, COST_TRACKING: 'false', CELERIS_API_KEY: 'fixture-process-key' });
const { celerisChat } = await import('./celeris.js');
const { withApplicationModel } = await import('../application-model.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

test('Celeris is the only transport and each concurrent request keeps its scoped key and endpoint', async () => {
  const seen: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') ?? '', body });
    await Promise.resolve();
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'fixture-call', type: 'function', function: { name: 'inspect', arguments: '{"target":"fixture"}' } },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }) as typeof fetch;
  const request = { model: 'celeris-1-magnus' as const, messages: [{ role: 'user' as const, content: 'Fictional application control.' }],
    tools: [{ name: 'inspect', description: 'Inspect a fictional field.', parameters: { type: 'object', properties: { target: { type: 'string' } } } }] };
  const replies = await Promise.all(['alpha', 'beta'].map(owner => withApplicationModel({
    DATA_DIR: join(directory, owner), CELERIS_API_KEY: `fixture-${owner}`, CELERIS_BASE_URL: `https://${owner}.fixture.invalid`,
  }, () => celerisChat(request))));
  assert.equal(seen.length, 2);
  for (const owner of ['alpha', 'beta']) {
    const call = seen.find(item => item.url === `https://${owner}.fixture.invalid/celeris-1-magnus/v1/chat/completions`);
    assert.ok(call); assert.equal(call.authorization, `Bearer fixture-${owner}`);
    assert.equal(call.body.model, 'celeris-1-magnus');
    assert.ok(Array.isArray(call.body.tools)); assert.ok(Array.isArray(call.body.messages));
    assert.equal(Object.hasOwn(call.body, 'provider'), false);
  }
  for (const reply of replies) {
    assert.deepEqual(reply.toolCalls, [{ id: 'fixture-call', name: 'inspect', args: { target: 'fixture' } }]);
    assert.equal(reply.message.role, 'assistant');
    assert.ok(reply.message.role === 'assistant' && reply.message.tool_calls);
  }
});

test('a scoped request without a Celeris key cannot borrow another process or account key', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('A credential-less scope must not call a provider.'); }) as typeof fetch;
  await assert.rejects(() => withApplicationModel({ DATA_DIR: join(directory, 'unconfigured') }, () => celerisChat({
    model: 'celeris-1', messages: [{ role: 'user', content: 'Fictional field.' }],
  })), /CELERIS_API_KEY is not set/);
  assert.equal(calls, 0);
});
