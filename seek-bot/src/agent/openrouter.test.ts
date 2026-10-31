import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApplicationModel, MINIMAX_APPLICATION_MODEL } from '../application-model.js';
import { applicationChat } from './application-chat.js';
import { CostMeter, ApplicationBudgetExhaustedError, type ChatMessage, type CelerisRequest } from './celeris.js';
import { agentOnlyTranscript, latestObservationScreenshotOnly } from './agent-only-transcript.js';

const tool = { name: 'browser_action', description: 'Use the native browser', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } };
const reply = (cost = 0.001, finish = 'tool_calls') => ({ choices: [{ finish_reason: finish, message: {
  role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-provider-block', index: 0 }],
  tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'browser_action', arguments: '{"action":"inspect"}' } }],
} }], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 500 }, completion_tokens: 100, cost } });

async function isolated(work: () => Promise<void>) {
  const original = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-openrouter-'));
  try {
    await withApplicationModel({ APPLICATION_AI_MODEL: 'minimax', OPENROUTER_API_KEY: 'fictional-private-key', DATA_DIR: directory }, work);
  } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }); }
}

test('MiniMax receives the full tools, screenshot, forced tool and unchanged reasoning continuation', async () => isolated(async () => {
  const requests: Record<string, any>[] = [];
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((options!.headers as Record<string, string>).authorization, 'Bearer fictional-private-key');
    requests.push(JSON.parse(String(options!.body)));
    return Response.json(reply());
  }) as typeof fetch;
  const meter = new CostMeter(1);
  const messages: ChatMessage[] = [{ role: 'system', content: 'Complete the synthetic application.' },
    { role: 'user', content: [{ type: 'text', text: 'Current page' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }];
  const request: CelerisRequest = { model: 'celeris-1-magnus', messages, tools: [tool], requireTool: true,
    forceTool: tool.name, thinking: true, reasoningEffort: 'xhigh', maxTokens: 8192, meter };
  const result = await applicationChat(request);
  assert.equal(result.toolCalls[0].args.action, 'inspect');
  messages.push(result.message, { role: 'tool', tool_call_id: 'call-one', content: 'Inspection complete' });
  const transcript = agentOnlyTranscript(latestObservationScreenshotOnly(messages), 10000);
  await applicationChat({ ...request, messages: transcript });
  assert.equal(requests[0].model, MINIMAX_APPLICATION_MODEL);
  assert.deepEqual(requests[0].tools, [{ type: 'function', function: tool }]);
  assert.deepEqual(requests[0].tool_choice, { type: 'function', function: { name: tool.name } });
  assert.deepEqual(requests[0].messages[1], messages[1]);
  assert.deepEqual(requests[0].reasoning, { effort: 'xhigh' });
  assert.deepEqual(requests[1].messages[2].reasoning_details, reply().choices[0].message.reasoning_details);
  assert.equal(meter.totals.costUsd, 0.002, 'provider cost overrides cheaper published estimates');
  assert.equal(meter.totals.cachedPromptTokens, 1000);
}));

test('a charged truncated response cannot resample past the application budget', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json(reply(0.2, 'length')); }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], meter: new CostMeter(0.2) }), ApplicationBudgetExhaustedError);
  assert.equal(calls, 1);
}));

test('one incomplete generation is retried without replaying tool actions and preserves its cost', async () => isolated(async () => {
  const requests: any[] = [];
  globalThis.fetch = (async (_url, options) => {
    requests.push(JSON.parse(String(options!.body)));
    return Response.json(reply(0.001, requests.length === 1 ? 'length' : 'tool_calls'));
  }) as typeof fetch;
  const meter = new CostMeter(1);
  await applicationChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Page' }], tools: [tool], maxTokens: 8192, meter });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].max_tokens, 16384);
  assert.equal(requests[1].messages.length, 2);
  assert.equal(meter.totals.calls, 2);
}));

test('auth failures do not retry, do not expose credentials and never switch providers', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: 'Invalid fictional-private-key', code: 401 } }, { status: 401 }); }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [] }), error => {
    assert.match(String(error), /OpenRouter 401/);
    assert.doesNotMatch(String(error), /fictional-private-key/);
    return true;
  });
  assert.equal(calls, 1);
  await withApplicationModel({ APPLICATION_AI_MODEL: 'minimax' }, async () => {
    await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [] }), /OPENROUTER_API_KEY/);
  });
  assert.equal(calls, 1);
}));

test('unreported charges reserve a nonzero budget instead of granting unlimited turns', async () => isolated(async () => {
  globalThis.fetch = (async () => {
    const payload: any = reply(); delete payload.usage;
    return Response.json(payload);
  }) as typeof fetch;
  const meter = new CostMeter(0.0001);
  await applicationChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Page' }], meter });
  assert.equal(meter.exhausted, true);
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], meter }), ApplicationBudgetExhaustedError);
}));

test('structured specialist responses use MiniMax and a server retry respects the remaining deadline', async () => isolated(async () => {
  let calls = 0;
  globalThis.fetch = (async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options!.body));
    assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'reply', schema: { type: 'object' } } });
    return Response.json({ error: { code: 429, message: 'Synthetic rate limit' } }, { status: 429, headers: { 'Retry-After': '10' } });
  }) as typeof fetch;
  await assert.rejects(applicationChat({ model: 'celeris-1-magnus', messages: [], responseSchema: { type: 'object' }, deadline: Date.now() + 1000 }), /retry deadline/);
  assert.equal(calls, 1, 'must not shorten Retry-After to retry early');
}));

test('model routing and credentials stay isolated across simultaneous Celeris and MiniMax turns', async () => isolated(async () => {
  const providers: string[] = [];
  globalThis.fetch = (async (url, options) => {
    const body = JSON.parse(String(options!.body));
    const auth = (options!.headers as Record<string, string>).authorization;
    if (String(url).includes('openrouter.ai')) {
      assert.equal(body.model, MINIMAX_APPLICATION_MODEL);
      assert.equal(auth, 'Bearer fictional-private-key'); providers.push('minimax');
    } else {
      assert.equal(body.model, 'celeris-1-magnus');
      assert.equal(auth, 'Bearer fictional-celeris-only'); providers.push('celeris');
    }
    return Response.json(reply());
  }) as typeof fetch;
  await Promise.all([
    applicationChat({ model: 'celeris-1-magnus', messages: [] }),
    withApplicationModel({ APPLICATION_AI_MODEL: 'celeris', CELERIS_API_KEY: 'fictional-celeris-only',
      CELERIS_MAX_CONCURRENT_REQUESTS: '0' }, () => applicationChat({ model: 'celeris-1-magnus', messages: [] })),
  ]);
  assert.deepEqual(providers.sort(), ['celeris', 'minimax']);
}));
