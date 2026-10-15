import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CelerisRequest, ChatMessage, CostMeter } from './celeris.js';
import { haikuBody, haikuChat, haikuMessages, haikuReasoning, haikuSchema, haikuSchemaComplexity, haikuUsage, HaikuConversationError, HaikuProviderError, HAIKU_SCHEMA_LIMITS, type HaikuRoute } from './haiku.js';
import { toolSchemas } from './tools/schemas.js';

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

test('an initial strict refusal is retried once only for that conversation', async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? Response.json({ error: { type: 'invalid_request_error', message: 'tools.0: strict schema not supported' } }, { status: 400 }) : Response.json(response());
  });
  const reply = await haikuChat(request(), route);
  assert.equal(bodies.length, 2); assert.equal(reply.toolCalls.length, 1);
  assert.equal((bodies[0].tools as Record<string, unknown>[])[0].strict, true);
  assert.equal((bodies[1].tools as Record<string, unknown>[])[0].strict, undefined);
  assert.equal((haikuBody(request(), route).tools as Record<string, unknown>[])[0].strict, true);
  const next = request([...request().messages, JSON.parse(JSON.stringify(reply.message)), { role: 'tool', tool_call_id: 'toolu_test', content: 'Saved result.' }, { role: 'user', content: 'Next observation.' }]);
  assert.deepEqual(haikuBody(next, route).tools, bodies[1].tools);
});

test('the complete production toolset stays available within the combined strict budget', () => {
  const production = toolSchemas({ vision: true, compact: true });
  assert.ok(production.length > HAIKU_SCHEMA_LIMITS.strictTools);
  const output = { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`field${n}`, { type: 'string' }])) };
  const body = haikuBody({ ...request(), tools: production, responseSchema: output }, route);
  const sent = body.tools as Record<string, unknown>[], strict = sent.filter(t => t.strict === true);
  assert.deepEqual(sent.map(t => t.name), production.map(t => t.name));
  assert.ok(strict.length > 0 && strict.length <= HAIKU_SCHEMA_LIMITS.strictTools);
  const combined = strict.reduce<{ optionalParameters: number; unionParameters: number }>((sum, t) => {
    const count = haikuSchemaComplexity(t.input_schema);
    return { optionalParameters: sum.optionalParameters + count.optionalParameters, unionParameters: sum.unionParameters + count.unionParameters };
  }, haikuSchemaComplexity(output));
  assert.ok(combined.optionalParameters <= HAIKU_SCHEMA_LIMITS.optionalParameters);
  assert.ok(combined.unionParameters <= HAIKU_SCHEMA_LIMITS.unionParameters);
  assert.throws(() => haikuBody({ ...request(), responseSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`field${n}`, { type: 'string' }])) } }, route), (e: unknown) => e instanceof HaikuConversationError && e.code === 'haiku-schema-budget');
});

test('signed native history freezes the exact wire definitions across JSON persistence', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response()); });
  const original = request(), reply = await haikuChat(original, route);
  const next = request([...original.messages, JSON.parse(JSON.stringify(reply.message)), { role: 'tool', tool_call_id: 'toolu_test', content: 'Saved result.' }, { role: 'user', content: 'Next observation.' }]);
  assert.deepEqual(haikuBody(next, route).tools, haikuBody(original, route).tools);
  const changed = { ...next, tools: [{ ...tools[0], description: 'Changed definition.' }] };
  await assert.rejects(() => haikuChat(changed, route), (e: unknown) => e instanceof HaikuConversationError && e.requiresFreshConversation && e.code === 'haiku-conversation-changed');
  const missing = structuredClone(next);
  delete (missing.messages.find(m => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>).anthropic_protocol;
  assert.throws(() => haikuBody(missing, route), (e: unknown) => e instanceof HaikuConversationError && e.code === 'haiku-history-metadata-missing');
  assert.equal(calls, 1);
});

test('signed-history strict rejection is typed and cannot mutate tools or trigger a fallback', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? Response.json(response()) : Response.json({ error: { type: 'invalid_request_error', message: 'tools.0: strict schema not supported' } }, { status: 400 });
  });
  const original = request(), reply = await haikuChat(original, route);
  const next = request([...original.messages, reply.message, { role: 'tool', tool_call_id: 'toolu_test', content: 'Saved result.' }]);
  await assert.rejects(() => haikuChat(next, route), (e: unknown) => e instanceof HaikuProviderError && e.code === 'strict-schema-rejected' && e.requiresFreshConversation);
  assert.equal(calls, 2);
});

test('grammar quota HTTP 400 honors Retry-After without changing signed tools or exposing private error text', async t => {
  const bodies: Record<string, unknown>[] = [], delays: number[] = [];
  let clock = 1000;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 2) return Response.json({ error: { type: 'invalid_request_error', message: 'Grammar compilation rate limit exceeded. Organization PRIVATE_ORG test@example.invalid sk-fictional-secret exceeded limit:50 compilations per minute.' } }, { status: 400, headers: { 'retry-after': '2', 'request-id': 'req_fixture' } });
    return Response.json(response({ content: [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'tool_use', id: `toolu_${bodies.length}`, name: 'read_page', input: {} }] }));
  });
  const original = request(), first = await haikuChat(original, route);
  const next = request([...original.messages, first.message, { role: 'tool', tool_call_id: 'toolu_1', content: 'Saved result.' }]);
  const reply = await haikuChat(next, route, { now: () => clock, random: () => 0, sleep: async ms => { delays.push(ms); clock += ms; } });
  assert.equal(reply.toolCalls.length, 1); assert.deepEqual(delays, [2000]);
  assert.deepEqual(bodies[1], bodies[2]); assert.deepEqual(bodies[0].tools, bodies[2].tools);
  assert.equal((haikuBody(request(), route).tools as Record<string, unknown>[])[0].strict, true);
});

test('persistent grammar quota has one cooldown, sanitizes errors, and respects the whole deadline', async t => {
  let calls = 0, clock = 0; const delays: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: { type: 'invalid_request_error', message: 'Grammar compilation rate limit exceeded. Organization PRIVATE_ORG test@example.invalid sk-fictional-secret exceeded limit:50 compilations per minute.' } }, { status: 400, headers: { 'request-id': 'req_fixture' } });
  });
  const check = (e: unknown) => {
    assert.ok(e instanceof HaikuProviderError); assert.equal(e.code, 'grammar-compilation-rate-limit'); assert.equal(e.status, 400);
    assert.equal(e.requestId, 'req_fixture'); assert.equal(e.requiresFreshConversation, false);
    assert.doesNotMatch(String(e) + JSON.stringify(e), /PRIVATE_ORG|example\.invalid|sk-fictional|compilations per minute/);
    return true;
  };
  await assert.rejects(() => haikuChat(request(), route, { now: () => clock, random: () => 0, sleep: async ms => { delays.push(ms); clock += ms; } }), check);
  assert.equal(calls, 2); assert.deepEqual(delays, [60000]);
  calls = 0; clock = 0;
  await assert.rejects(() => haikuChat(request(), { ...route, timeoutMs: 5000 }, { now: () => clock, sleep: async () => { assert.fail('Cooldown must not overrun the deadline.'); } }), check);
  assert.equal(calls, 1);
});

const nativeBrowser = { type: 'browser_toolset_20260801' as const, configs: { javascript_exec: { enabled: false }, file_upload: { enabled: false } } };
const browserState = { type: 'browser_state', tabs: [{ tab_id: 'fixture-tab', title: 'Fictional application', url: 'https://fixture.invalid/form', active: true }] };

test('native browser declaration accompanies custom grounding helpers without fake member schemas', () => {
  for (const selected of [route, { ...route, provider: 'Anthropic' as const, model: 'claude-haiku-5-5' }]) {
    const body = haikuBody({ ...request(), anthropicBrowserToolset: nativeBrowser }, selected);
    const sent = body.tools as Record<string, unknown>[];
    assert.equal(sent.length, 2);
    assert.equal(sent[1].name, undefined); assert.equal(sent[1].strict, undefined); assert.equal(sent[1].input_schema, undefined);
    assert.deepEqual(sent[1], nativeBrowser);
    assert.equal(sent[0].name, 'read_page'); assert.equal(sent[0].strict, true);
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
  }
  const only = haikuBody({ ...request(), tools: undefined, thinking: false, anthropicBrowserToolset: nativeBrowser }, route);
  assert.deepEqual(only.tools, [nativeBrowser]); assert.deepEqual(only.thinking, { type: 'adaptive' });
  assert.throws(() => haikuBody({ ...request(), tools: [{ ...tools[0], name: 'browser' }], anthropicBrowserToolset: nativeBrowser }, route), /namespace/);
  assert.throws(() => haikuBody({ ...request(), anthropicBrowserToolset: { ...nativeBrowser, configs: { invented_member: { enabled: true } } } }, route), /declaration/);
});

test('native member and identically named custom helper remain distinct through signed replay', async t => {
  const blocks = [{ type: 'thinking', thinking: '', signature: 'opaque-native-signature', opaque_extra: { untouched: true } },
    { type: 'tool_use', id: 'native_read', name: 'read_page', toolset_name: 'browser', input: { filter: 'interactive', depth: 5 } },
    { type: 'tool_use', id: 'custom_read', name: 'read_page', input: {} }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(response({ content: blocks })));
  const r = { ...request(), anthropicBrowserToolset: nativeBrowser }, reply = await haikuChat(r, route);
  assert.deepEqual(reply.toolCalls, [{ id: 'native_read', name: 'read_page', toolset_name: 'browser', args: { filter: 'interactive', depth: 5 } }, { id: 'custom_read', name: 'read_page', args: {} }]);
  const nativeContent = [{ type: 'text', text: 'textbox "Fictional name" [ref_1]' }, browserState];
  const next = { ...r, messages: [...r.messages, JSON.parse(JSON.stringify(reply.message)),
    { role: 'tool' as const, tool_call_id: 'native_read', toolset_name: 'browser' as const, content: '', anthropic_content: nativeContent },
    { role: 'tool' as const, tool_call_id: 'custom_read', content: 'Custom helper result.' }, { role: 'user' as const, content: 'Fresh observation.' }] };
  const body = haikuBody(next, route), messages = body.messages as { content: unknown[] }[];
  assert.deepEqual(messages[1].content, blocks);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'native_read', toolset_name: 'browser', content: nativeContent }, { type: 'tool_result', tool_use_id: 'custom_read', content: 'Custom helper result.' }]);
  assert.deepEqual(body.tools, haikuBody(r, route).tools);
  assert.throws(() => haikuBody({ ...next, anthropicBrowserToolset: { ...nativeBrowser, configs: { ...nativeBrowser.configs, wait: { enabled: false } } } }, route), (e: unknown) => e instanceof HaikuConversationError && e.requiresFreshConversation);
});

test('native screenshot images and browser state are replayed as structured blocks', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const start: ChatMessage[] = [{ role: 'user', content: 'Inspect fictional page.' }, { role: 'assistant', content: null,
    anthropic_content: [{ type: 'tool_use', id: 'shot', name: 'screenshot', toolset_name: 'browser', input: {} }] }];
  const result: ChatMessage = { role: 'tool', tool_call_id: 'shot', toolset_name: 'browser', content: '', anthropic_content: [image, browserState] };
  const built = haikuMessages([...start, result]);
  assert.deepEqual(built.messages[2].content, [{ type: 'tool_result', tool_use_id: 'shot', toolset_name: 'browser', content: [image, browserState] }]);
  assert.throws(() => haikuMessages([...start, { ...result, toolset_name: undefined }]), /namespace/);
  assert.throws(() => haikuMessages([...start, { ...result, is_error: true }]), /error/);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ type: 'text', text: 'Screenshot taken.' }] }]), /image/);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ ...image, source: { type: 'url', url: 'file:///private' } }] }]), /image/);
});

test('native tab calls require complete structured inventory and errors preserve their namespace', () => {
  const start: ChatMessage[] = [{ role: 'user', content: 'List fictional tabs.' }, { role: 'assistant', content: null,
    anthropic_content: [{ type: 'tool_use', id: 'tabs', name: 'list_tabs', toolset_name: 'browser', input: {} }] }];
  const result: ChatMessage = { role: 'tool', tool_call_id: 'tabs', toolset_name: 'browser', content: '', anthropic_content: [browserState] };
  assert.deepEqual(haikuMessages([...start, result]).messages[2].content, [{ type: 'tool_result', tool_use_id: 'tabs', toolset_name: 'browser', content: [browserState] }]);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ type: 'text', text: 'Tabs:' }, browserState] }]), /exactly one/);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ ...browserState, tabs: [{ ...browserState.tabs[0], active: false }] }] }]), /inventory/);
  const halted = 'Not executed: an earlier action in this turn failed.';
  const failed = haikuMessages([...start, { role: 'tool', tool_call_id: 'tabs', toolset_name: 'browser', content: halted, is_error: true }]);
  assert.deepEqual(failed.messages[2].content, [{ type: 'tool_result', tool_use_id: 'tabs', toolset_name: 'browser', is_error: true, content: halted }]);
});

test('native new-tab and download events satisfy the documented state constraints', () => {
  const start: ChatMessage[] = [{ role: 'user', content: 'Open fictional tab.' }, { role: 'assistant', content: null,
    anthropic_content: [{ type: 'tool_use', id: 'new', name: 'new_tab', toolset_name: 'browser', input: {} }] }];
  const state = { ...browserState, state_changes: [{ type: 'tab_opened', tab_id: 'fixture-tab' }] };
  const result: ChatMessage = { role: 'tool', tool_call_id: 'new', toolset_name: 'browser', content: '', anthropic_content: [state] };
  assert.deepEqual(haikuMessages([...start, result]).messages[2].content, [{ type: 'tool_result', tool_use_id: 'new', toolset_name: 'browser', content: [state] }]);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ ...state, state_changes: [{ type: 'tab_opened', tab_id: 'unknown' }] }] }]), /inventory/);
  assert.throws(() => haikuMessages([...start, { ...result, anthropic_content: [{ ...state, state_changes: [] }] }]), /state changes/);
  const readStart: ChatMessage[] = [{ role: 'user', content: 'Read fictional tab.' }, { role: 'assistant', content: null,
    anthropic_content: [{ type: 'tool_use', id: 'read', name: 'read_page', toolset_name: 'browser', input: {} }] }];
  const downloaded = { ...browserState, state_changes: [{ type: 'download_completed', download_id: 'fixture-download', url: 'https://fixture.invalid/file', size_bytes: 12 }] };
  const readResult: ChatMessage = { role: 'tool', tool_call_id: 'read', toolset_name: 'browser', content: '', anthropic_content: [{ type: 'text', text: 'Read complete.' }, downloaded] };
  assert.equal(haikuMessages([...readStart, readResult]).messages.length, 3);
  assert.throws(() => haikuMessages([...readStart, { ...readResult, anthropic_content: [{ ...downloaded, state_changes: [...downloaded.state_changes, ...downloaded.state_changes] }] }]), /download event/);
});

test('undeclared, disabled and malformed native browser calls release no executable actions', async t => {
  const cases = [
    { type: 'tool_use', id: 'a', name: 'invented', toolset_name: 'browser', input: {} },
    { type: 'tool_use', id: 'a', name: 'javascript_exec', toolset_name: 'browser', input: { text: '1+1' } },
    { type: 'tool_use', id: 'a', name: 'left_click', toolset_name: 'browser', input: { target: { type: 'coordinate', x: -1, y: 0 } } },
    { type: 'tool_use', id: 'a', name: 'wait', toolset_name: 'browser', input: { duration: 31 } },
    { type: 'tool_use', id: 'a', name: 'navigate', toolset_name: 'computer', input: { url: 'https://fixture.invalid' } },
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response({ content: [cases.shift()] })); });
  for (let i = 0; i < 5; i++) await assert.rejects(() => haikuChat({ ...request(), anthropicBrowserToolset: nativeBrowser }, route), /no action returned/);
  assert.equal(calls, 5);
});

test('custom tools cannot return browser state without a native member call', () => {
  const start: ChatMessage[] = [{ role: 'user', content: 'Inspect.' }, { role: 'assistant', content: null, anthropic_content: [{ type: 'tool_use', id: 'a', name: 'read_page', input: {} }] }];
  assert.throws(() => haikuMessages([...start, { role: 'tool', tool_call_id: 'a', content: '', anthropic_content: [browserState] }]), /only on a native/);
});
