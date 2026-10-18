import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { haikuBody, haikuTools, haikuUsage, validHaikuInput } from './haiku.js';
import { celerisChat, CostMeter, type CelerisRequest, type ChatMessage } from './celeris.js';
import { withApplicationModel, applicationModelIdentity } from '../application-model.js';
import { systemPrompt } from './loop/prompt.js';
import { toolSchemas } from './tools/schemas.js';
import { answerFields } from '../llm.js';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const environment = { APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'fictional-private-key', COST_TRACKING: 'false' };
const request: CelerisRequest = { model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Synthetic question.' }], thinking: true, reasoningEffort: 'low' };
const response = (content: unknown[], stop_reason = 'end_turn') => Response.json({ content, stop_reason,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 50 } });

test('Haiku uses its own prompt, tools and native message schema; one-off prompts are not cache writes', () => withApplicationModel(environment, () => {
  const body = haikuBody({ ...request, responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }, 'medium');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal((body.output_config as { effort: string }).effort, 'medium');
  assert.ok(!JSON.stringify(body).includes('cache_control'));
  assert.ok(!JSON.stringify(body).includes('chat_template_kwargs'));
  assert.match(systemPrompt(), /You are Claude Haiku/);
  assert.match(systemPrompt(), /low- and medium-risk questions/);
  const tools = toolSchemas({ vision: true });
  assert.match(tools.find(tool => tool.name === 'answer_questions')!.description, /You \(Haiku\)/);
  const native = haikuTools(tools);
  assert.ok(native.filter(tool => tool.strict).length <= 20);
  assert.ok(native.some(tool => tool.name === 'answer_questions' && tool.strict));
  assert.ok(native.every(tool => (tool.input_schema as { additionalProperties: boolean }).additionalProperties === false));
  assert.ok(!('format' in (haikuBody({ ...request, tools, requireTool: true }, 'medium').output_config as object)));
}));

test('signed thinking and complete tool results survive the next request unchanged; screenshots are native images', () => {
  const signed = [{ type: 'thinking', thinking: 'opaque fixture', signature: 'unchanged-signature' },
    { type: 'tool_use', id: 'one', name: 'click', input: { ref: 'a1' } },
    { type: 'tool_use', id: 'two', name: 'scroll', input: { direction: 'down' } }];
  const transcript: ChatMessage[] = [
    { role: 'system', content: 'Fixed rules' }, { role: 'user', content: 'Page one' },
    { role: 'assistant', content: null, nativeContent: signed },
    { role: 'tool', tool_call_id: 'one', content: 'Clicked' }, { role: 'tool', tool_call_id: 'two', content: 'Not run: first action changed page' },
    { role: 'user', content: [{ type: 'text', text: 'Page two' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
  ];
  const before = JSON.stringify(transcript);
  const body = haikuBody({ ...request, messages: transcript }, 'high');
  const messages = body.messages as Array<{ role: string; content: Record<string, unknown>[] }>;
  assert.deepEqual(messages[1].content, signed);
  assert.deepEqual(messages[2].content.slice(0, 2).map(block => block.tool_use_id), ['one', 'two']);
  assert.equal(messages[2].content[2].text, 'Page two');
  assert.equal(messages[2].content[3].type, 'image');
  assert.equal(JSON.stringify(transcript), before);
});

test('concurrent account selections never send Haiku data or its key to Celeris', async () => {
  const seen: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key'), body });
    await Promise.resolve();
    return String(url).endsWith('/messages') ? response([{ type: 'text', text: '{"ok":true}' }])
      : Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  await Promise.all([
    withApplicationModel(environment, () => celerisChat({ ...request, messages: [{ role: 'user', content: 'HAIKU_PRIVATE' }] })),
    withApplicationModel({ CELERIS_API_KEY: 'fictional-celeris' }, () => celerisChat({ ...request, messages: [{ role: 'user', content: 'CELERIS_PRIVATE' }] })),
  ]);
  assert.equal(seen.length, 2);
  const haiku = seen.find(call => call.url.endsWith('/messages'))!, celeris = seen.find(call => !call.url.endsWith('/messages'))!;
  assert.equal(haiku.key, environment.ANTHROPIC_API_KEY);
  assert.equal(celeris.key, null);
  assert.ok(!JSON.stringify(haiku.body).includes('CELERIS_PRIVATE'));
  assert.ok(!JSON.stringify(celeris.body).includes('HAIKU_PRIVATE'));
});

test('medium is default; unusable output retries once at high before any browser action, and normal calls return to medium', async () => {
  const efforts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); efforts.push(body.output_config.effort);
    return efforts.length === 1 ? response([], 'max_tokens') : response([{ type: 'text', text: '{"ok":true}' }]);
  }) as typeof fetch;
  await withApplicationModel(environment, async () => {
    const meter = new CostMeter(1);
    assert.equal((await celerisChat({ ...request, meter })).text, '{"ok":true}');
    assert.equal(meter.totals.calls, 2);
    await celerisChat(request);
    await celerisChat({ ...request, reasoningEffort: 'xhigh' });
  });
  assert.deepEqual(efforts, ['medium', 'high', 'medium', 'high']);
});

test('bad calls are returned as repairable errors, and HTTP 400 never falls back or loops', async () => {
  const tools = [{ name: 'click', description: 'Click a current ref', parameters: { type: 'object', properties: { ref: { type: 'string' }, sends_application: { type: 'boolean' } }, required: ['ref', 'sends_application'] } }];
  globalThis.fetch = (async () => response([{ type: 'tool_use', id: 'bad', name: 'click', input: { ref: 'a1', sends_application: 'false' } }], 'tool_use')) as typeof fetch;
  await withApplicationModel(environment, async () => {
    const result = await celerisChat({ ...request, tools, requireTool: true });
    assert.ok(result.toolCalls[0].args.__parseError);
  });
  assert.equal(validHaikuInput({ ref: 'a1', sends_application: false }, tools[0].parameters), true);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('fixture invalid', { status: 400 }); }) as typeof fetch;
  await assert.rejects(() => withApplicationModel(environment, () => celerisChat(request)), /HTTP 400/);
  assert.equal(calls, 1);
  assert.throws(() => withApplicationModel({ APPLICATION_AI_MODEL: 'haiku', CELERIS_API_KEY: 'do-not-borrow' }, () => {
    assert.equal(applicationModelIdentity().selection, 'haiku'); throw new Error('fixture');
  }), /fixture/);
  await assert.rejects(() => withApplicationModel({ APPLICATION_AI_MODEL: 'haiku', CELERIS_API_KEY: 'do-not-borrow' }, () => celerisChat(request)), /ANTHROPIC_API_KEY/);
});

test('Haiku usage includes cached writes, reads and reasoning at Anthropic rates', () => {
  const usage = haikuUsage({ input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 })!;
  assert.deepEqual(usage, { prompt: 3500, cached: 2000, completion: 100, amountUsd: 0.0002325 });
  assert.equal(haikuUsage(undefined), null);
  assert.equal(haikuUsage({ input_tokens: 100_001, output_tokens: 0 })!.amountUsd, 0.0500005);
});

test('routine answer failures recover at high; only explicitly high-risk unknowns can reach the candidate', async () => {
  const profile = { name: 'Synthetic', phone: '', email: 'fixture@example.test', nationality: '', expectedSalary: '', noticePeriod: '',
    willingToRelocate: false, experienceSummary: '', skills: [], excludedDomains: [], securityClearance: '' };
  const job = { id: 'synthetic-risk', title: 'Assistant', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid' };
  const field = { ref: 'f0', label: 'Are you willing to obtain a first aid certificate?', kind: 'text' as const, required: true };
  const efforts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); efforts.push(body.output_config.effort);
    assert.match(JSON.stringify(body), /HAIKU QUESTION RISK POLICY/);
    const answer = efforts.length === 1
      ? { ref: 'f0', value: '', grounded: false, basis: 'none', risk: 'medium', applicationQuestion: true }
      : { ref: 'f0', value: 'I am willing to obtain a first aid certificate.', grounded: true, basis: 'composed', risk: 'medium', applicationQuestion: true };
    return response([{ type: 'text', text: JSON.stringify({ answers: [answer], injectionSuspected: false }) }]);
  }) as typeof fetch;
  const options = { savedAnswers: [], workPreferences: { arrangements: ['hybrid'], onsiteCity: 'Sydney', instructions: '' } };
  await withApplicationModel(environment, async () => {
    const result = await answerFields([field], job, profile, '', options);
    assert.equal(result.answers[0].grounded, true);
    assert.deepEqual(efforts, ['medium', 'high']);
    globalThis.fetch = (async () => response([{ type: 'text', text: JSON.stringify({ answers: [{ ref: 'f0', value: '', grounded: false,
      basis: 'none', risk: 'high', applicationQuestion: true, candidatePrompt: 'What are your Australian work rights?' }], injectionSuspected: false }) }])) as typeof fetch;
    const high = await answerFields([{ ...field, label: 'What are your Australian work rights?' }], job, profile, '', options);
    assert.equal(high.answers[0].grounded, false);
    assert.equal(high.answers[0].risk, 'high');
    globalThis.fetch = (async () => response([{ type: 'text', text: JSON.stringify({ answers: [{ ref: 'f0', value: '', grounded: false,
      basis: 'none', risk: 'low', applicationQuestion: true }], injectionSuspected: false }) }])) as typeof fetch;
    await assert.rejects(() => answerFields([field], job, profile, '', options), /No question was sent to the candidate/);
  });
});
