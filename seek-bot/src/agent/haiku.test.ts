import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CelerisRequest, ChatMessage, CostMeter } from './celeris.js';
import { haikuBody, haikuChat, haikuMessages, haikuReasoning, haikuSchema, haikuUsage, type HaikuRoute } from './haiku.js';

// Every provider response is mocked. These tests never contact an AI or a browser.
process.env.COST_TRACKING = 'false';
const route: HaikuRoute = { provider: 'OpenRouter', apiKey: 'fictional-test-key',
  model: 'anthropic/claude-haiku-5.5', endpoint: 'https://openrouter.ai/api/v1/messages' };
const tools = [{ name: 'read_page', description: 'Read the current saved form without changing it.', parameters: { type: 'object', properties: {} } }];
const request = (messages: ChatMessage[] = [{ role: 'system', content: 'Fictional test only.' }, { role: 'user', content: 'Inspect the form.' }]): CelerisRequest => ({ model: 'celeris-1-magnus', messages, tools, requireTool: true, thinking: true, reasoningEffort: 'xhigh', temperature: 0 });
const response = (extra: Record<string, unknown> = {}) => ({ id: 'msg_fictional', model: route.model, role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'thinking', signature: 'fictional-signature', thinking: '' }, { type: 'tool_use', id: 'toolu_test', name: 'read_page', input: {} }],
  usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 50, cost: .00005 }, ...extra });
function meter() {
  const rows: { usage: unknown; amount: number | undefined }[] = [];
  return { rows, value: { record(usage: unknown, amount?: number) { rows.push({ usage, amount }); } } as unknown as CostMeter };
}

test('native body uses Anthropic contracts and leaves thinking adaptive', () => {
  const r = request([{ role: 'system', content: 'Constant prefix.' }, { role: 'user', content: [
    { type: 'text', text: 'Fictional page' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }]);
  r.maxTokens = 512; r.responseSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const body = haikuBody(r, route);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: { ...r.responseSchema, additionalProperties: false } } });
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.tools, tools.map(t => ({ name: t.name, description: t.description, input_schema: { ...t.parameters, additionalProperties: false }, strict: true })));
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, undefined); assert.equal(body.reasoning, undefined); assert.equal(body.chat_template_kwargs, undefined);
  assert.deepEqual((body.messages as { content: unknown[] }[])[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(body.provider, { only: ['anthropic'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' });
});

test('signed native blocks replay verbatim and all tool results precede new observations', () => {
  const signed = [{ type: 'thinking', thinking: '', signature: 'opaque-test-signature', extra: { preserve: true } },
    { type: 'redacted_thinking', data: 'opaque-test-data' },
    { type: 'text', text: 'Reading both views.' },
    { type: 'tool_use', id: 'a', name: 'read_page', input: {} },
    { type: 'tool_use', id: 'b', name: 'read_page', input: {} }];
  const messages: ChatMessage[] = [{ role: 'user', content: 'Inspect.' }, { role: 'assistant', content: '[legacy prose must not replace native blocks]', anthropic_content: signed },
    { role: 'tool', tool_call_id: 'a', content: 'First actual result.' }, { role: 'tool', tool_call_id: 'b', content: 'Second actual result.' }, { role: 'user', content: 'Fresh observation.' }];
  const original = structuredClone(messages), built = haikuMessages(messages);
  assert.deepEqual(built.messages[1].content, signed); assert.deepEqual(messages, original);
  assert.deepEqual(built.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'First actual result.' }, { type: 'tool_result', tool_use_id: 'b', content: 'Second actual result.' }] });
  assert.deepEqual(built.messages[3], { role: 'user', content: [{ type: 'text', text: 'Fresh observation.' }] });
});

test('invalid, duplicated, missing or interleaved tool results cannot reach the provider', () => {
  const assistant: ChatMessage = { role: 'assistant', content: null, anthropic_content: [{ type: 'tool_use', id: 'a', name: 'read_page', input: {} }] };
  const start: ChatMessage[] = [{ role: 'user', content: 'Inspect.' }, assistant];
  assert.throws(() => haikuMessages([...start, { role: 'user', content: 'Interleaved observation.' }]), /immediately follow/);
  assert.throws(() => haikuMessages(start), /missing/);
  assert.throws(() => haikuMessages([...start, { role: 'tool', tool_call_id: 'wrong', content: 'No.' }]), /unknown or duplicated/);
  assert.throws(() => haikuMessages([...start, { role: 'tool', tool_call_id: 'a', content: 'First.' }, { role: 'tool', tool_call_id: 'a', content: 'Duplicate.' }]), /unknown or duplicated/);
  assert.throws(() => haikuMessages([{ role: 'user', content: 'Inspect.' }, { role: 'assistant', content: 'Unfinished prefill.' }]), /assistant prefill/);
});

test('native cache accounting sums disjoint input categories and applies the long-prompt threshold', () => {
  const usage = haikuUsage({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 400 } });
  assert.equal(usage?.prompt_tokens, 3100); assert.equal(usage?.prompt_tokens_details.cached_tokens, 2000);
  assert.equal(usage?.estimatedUsd, (100 * .1 + 600 * .125 + 400 * .2 + 2000 * .01 + 50 * .5) / 1e6);
  const long = haikuUsage({ input_tokens: 1, cache_read_input_tokens: 100000, output_tokens: 100 });
  assert.equal(long?.estimatedUsd, 5 * (.1 + 100000 * .01 + 100 * .5) / 1e6);
  assert.equal(haikuUsage({ input_tokens: 20 }), null);
});

test('native schema transformation preserves property names and retains unsupported constraints as requirements', () => {
  const original = { type: 'object', properties: {
    minimum: { type: 'integer', minimum: 0, maximum: 100 },
    reason: { type: 'string', maxLength: 120 },
    entries: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] } },
  }, required: ['minimum', 'reason'] };
  const schema = haikuSchema(original) as { properties: Record<string, Record<string, unknown>>; additionalProperties: unknown };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.minimum.minimum, undefined); assert.match(String(schema.properties.minimum.description), /"minimum":0,"maximum":100/);
  assert.equal(schema.properties.reason.maxLength, undefined); assert.match(String(schema.properties.reason.description), /"maxLength":120/);
  assert.equal(schema.properties.entries.minItems, undefined);
  assert.deepEqual((schema.properties.entries.items as { properties: unknown }).properties, { type: { type: 'string' } });
  assert.equal(original.properties.minimum.maximum, 100);
});

test('native response returns executable calls and preserves every original assistant block', async t => {
  const sent: { url: string; init?: RequestInit }[] = [], m = meter(); const payload = response();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: String(url), init }); return Response.json(payload); });
  const reply = await haikuChat({ ...request(), meter: m.value }, route);
  assert.deepEqual(reply.toolCalls, [{ id: 'toolu_test', name: 'read_page', args: {} }]);
  assert.equal(reply.message.role, 'assistant'); assert.deepEqual((reply.message as Extract<ChatMessage, { role: 'assistant' }>).anthropic_content, payload.content);
  assert.equal(sent.length, 1); assert.equal(sent[0].url, route.endpoint);
  assert.equal((sent[0].init?.headers as Record<string, string>).authorization, 'Bearer fictional-test-key');
  assert.equal(m.rows[0].amount, .00005);
  assert.equal((m.rows[0].usage as { prompt_tokens: number }).prompt_tokens, 200);
});

test('OpenRouter generation metadata is an accounting read, not a second model call', async t => {
  const calls: string[] = [], m = meter();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json(response({ id: 'gen-fictional', usage: { input_tokens: 100, output_tokens: 30 } }));
    return Response.json({ data: { id: 'gen-fictional', model: route.model, provider_name: 'Anthropic', total_cost: .000024 } });
  });
  await haikuChat({ ...request(), meter: m.value }, route);
  assert.equal(calls.length, 2); assert.match(calls[1], /^https:\/\/openrouter.ai\/api\/v1\/generation\?id=gen-fictional$/);
  assert.equal(m.rows[0].amount, .000024);
});

test('missing actual billing uses a published estimate only in the budget and retains valid actions', async t => {
  const m = meter(); t.mock.method(globalThis, 'fetch', async () => Response.json(response({ usage: { input_tokens: 100, output_tokens: 30 } })));
  const result = await haikuChat({ ...request(), meter: m.value }, route);
  assert.equal(result.toolCalls.length, 1); assert.equal(m.rows[0].amount, (100 * .1 + 30 * .5) / 1e6);
});

test('direct Anthropic authentication and native structured output need no Chat response format', async t => {
  const nativeRoute: HaikuRoute = { ...route, provider: 'Anthropic', model: 'claude-haiku-5-5', endpoint: 'https://api.anthropic.com/v1/messages' };
  let sent: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    sent = init; return Response.json(response({ model: nativeRoute.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 40, output_tokens: 10 } }));
  });
  const result = await haikuChat({ ...request(), tools: undefined, responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }, nativeRoute);
  const body = JSON.parse(String(sent?.body));
  assert.equal(result.text, '{"ok":true}'); assert.equal(body.response_format, undefined); assert.equal(body.provider, undefined);
  assert.equal((sent?.headers as Record<string, string>)['x-api-key'], route.apiKey);
  assert.equal((sent?.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(body.output_config.format, { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
});

test('truncated, refused, mismatched-model and malformed-tool replies release no action', async t => {
  const cases = [response({ stop_reason: 'max_tokens' }), response({ stop_reason: 'refusal' }), response({ model: 'anthropic/claude-sonnet-5.5' }),
    response({ content: [{ type: 'tool_use', id: 'a', name: 'unavailable_tool', input: {} }] })];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(cases.shift()); });
  for (let n = 0; n < 4; n++) await assert.rejects(() => haikuChat(request(), route), /no action returned/);
  assert.equal(calls, 4);
});

test('Ajv enforces original structured-output constraints after provider-compatible transformation', async t => {
  const values = [{ priority: 101, reason: 'Fine' }, { priority: 10, reason: 'Too long' }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(response({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(values.shift()) }] })));
  const r = { ...request(), tools: undefined, responseSchema: { type: 'object', properties: { priority: { type: 'integer', minimum: 0, maximum: 100 }, reason: { type: 'string', maxLength: 4 } }, required: ['priority', 'reason'] } };
  for (let n = 0; n < 2; n++) await assert.rejects(() => haikuChat(r, route), /did not satisfy its original schema/);
});

test('Ajv validates native tool inputs before browser actions are released', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(response()));
  const r = { ...request(), tools: [{ ...tools[0], parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } }] };
  await assert.rejects(() => haikuChat(r, route), /tool input did not satisfy its original schema; no action returned/);
});

test('bad-request failures do not retry or fall back to another model', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 }); });
  await assert.rejects(() => haikuChat(request(), route), /HTTP 400/); assert.equal(calls, 1);
});

test('one bounded transient retry resends model transport only', async t => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? Response.json({ error: {} }, { status: 520 }) : Response.json(response()); });
  const reply = await haikuChat(request(), route);
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]); assert.equal(reply.toolCalls.length, 1);
});

test('effort follows the reasoning tier each call asks for; a tool conversation keeps one level', () => {
  const ask = (extra: Partial<CelerisRequest>) => haikuReasoning({ model: 'celeris-1', messages: [{ role: 'user', content: 'Fictional.' }], ...extra }, route);
  assert.deepEqual(ask({ thinking: false }), { effort: 'low', thinking: { type: 'disabled' } });
  assert.deepEqual(ask({ model: 'celeris-1-magnus', thinking: true }), { effort: 'medium', thinking: { type: 'adaptive' } });
  assert.deepEqual(ask({ model: 'celeris-1-magnus', thinking: true, reasoningEffort: 'medium' }), { effort: 'high', thinking: { type: 'adaptive' } });
  assert.deepEqual(ask({ model: 'celeris-1-magnus', thinking: true, reasoningEffort: 'xhigh' }), { effort: 'high', thinking: { type: 'adaptive' } });
  assert.deepEqual(haikuReasoning(request(), route), { effort: 'medium', thinking: { type: 'adaptive' } });
  const body = haikuBody({ model: 'celeris-1', messages: [{ role: 'user', content: 'Is this a final submit? {"sends_application":true|false}' }], thinking: false, responseSchema: { type: 'object', properties: { sends_application: { type: 'boolean' } }, required: ['sends_application'] } }, route);
  assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal((body.output_config as { effort: string }).effort, 'low');
});

test('one-off prompts cache only a trusted prefix that has repeated', () => {
  const rules = `Fictional screening rules.\n${'Apply the same fictional guidance to every listing. '.repeat(60)}`;
  const prompt = (job: string) => `${rules}\n<untrusted role="job-listing">\n${job}\n</untrusted>`;
  const one = (text: string) => haikuBody({ model: 'celeris-1', messages: [{ role: 'user', content: text }], thinking: false }, route);
  const first = one(prompt('Fictional job A')), second = one(prompt('Fictional job B'));
  for (const body of [first, second]) assert.equal(body.cache_control, undefined);
  const blocks = (body: Record<string, unknown>) => (body.messages as { content: Record<string, unknown>[] }[])[0].content;
  assert.equal(blocks(first).length, 2); assert.equal(blocks(first)[0].cache_control, undefined);
  assert.equal(blocks(first).map(b => b.text).join(''), prompt('Fictional job A'));
  assert.deepEqual(blocks(second)[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks(second).map(b => b.text).join(''), prompt('Fictional job B'));
  const short = one('Short fictional question.\n<untrusted>Data</untrusted>');
  assert.equal(blocks(short).length, 1); assert.equal(short.cache_control, undefined);
});

test('strict tools are sent only for closed schemas', () => {
  const open = { name: 'free_form', description: 'Fictional open object.', parameters: { type: 'object', properties: { extra: { type: 'object' } } } };
  const closed = { name: 'pick', description: 'Fictional closed object.', parameters: { type: 'object', properties: { ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' }, maxItems: 3 } }, required: ['ref'] } };
  const sent = haikuBody({ ...request(), tools: [open, closed] }, route).tools as Record<string, unknown>[];
  assert.equal(sent[0].strict, undefined); assert.deepEqual(sent[0].input_schema, open.parameters);
  assert.equal(sent[1].strict, true);
  const schema = sent[1].input_schema as { additionalProperties: unknown; properties: { values: Record<string, unknown> } };
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.values.maxItems, undefined);
});

// Last: a refusal turns strict tools off for the rest of the process.
test('a refused strict schema is resent once without strict mode', async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? Response.json({ error: { type: 'invalid_request_error', message: 'tools.0: strict schema not supported' } }, { status: 400 }) : Response.json(response());
  });
  const reply = await haikuChat(request(), route);
  assert.equal(bodies.length, 2); assert.equal(reply.toolCalls.length, 1);
  assert.equal((bodies[0].tools as Record<string, unknown>[])[0].strict, true);
  assert.equal((bodies[1].tools as Record<string, unknown>[])[0].strict, undefined);
});
