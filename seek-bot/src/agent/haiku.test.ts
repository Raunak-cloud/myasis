import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { haikuBody, haikuSchema, haikuTools, haikuUsage, validHaikuInput } from './haiku.js';
import { celerisChat, CostMeter, type CelerisRequest, type ChatMessage } from './celeris.js';
import { withApplicationModel, applicationModelIdentity } from '../application-model.js';
import { systemPrompt } from './loop/prompt.js';
import { toolSchemas } from './tools/schemas.js';
import { answerFields, finishedCoverLetterForJob, formatCoverLetterParagraphs } from '../llm.js';
import { APPLICATION_EVIDENCE_RULES } from '../application-answer-policy.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCandidateEvidence } from './tools/candidate-evidence.js';
import { doFinish } from './tools/finish.js';
import type { ToolContext } from './tools/context.js';

test('candidate evidence stays account scoped and known facts do not become human questions', async () => {
  const dirs = ['A', 'B'].map(() => mkdtempSync(join(tmpdir(), 'haiku-evidence-')));
  try {
    const outputs = await Promise.all(dirs.map((directory, index) => withApplicationModel({ ...environment, DATA_DIR: directory }, async () => {
      const marker = `PRIVATE_ACCOUNT_${index}`;
      const answers = JSON.stringify([{ question: 'Qualification', answer: `${marker} MBBS` }]);
      writeFileSync(join(directory, 'answers.json'), answers);
      writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([{ id: marker, kind: 'note', label: 'Clinical CV', text: `${marker} medical officer experience`, enabled: true }]));
      const ctx = { profile: { name: marker, qualification: 'MBBS' }, job: { title: 'Patient Concierge' }, resumeUsed: 'Retail CV', guards: { ungrounded: [], pendingFields: new Set() } } as unknown as ToolContext;
      const result = await readCandidateEvidence(ctx, 'medical qualifications');
      assert.equal(result.kind, 'ok');
      const text = result.kind === 'ok' ? result.message : '';
      assert.match(text, new RegExp(`${marker} medical officer experience`));
      assert.match(text, /MBBS/);
      assert.match(text, /omission.*does not contradict/s);
      assert.equal(readFileSync(join(directory, 'answers.json'), 'utf8'), answers, 'read does not alter saved evidence');
      const stopped = await doFinish(ctx, { status: 'needs_human', reason: 'The retail CV omits MBBS' });
      assert.equal(stopped.kind === 'terminal' && stopped.outcome.status, 'skipped', 'no missing candidate fact means a stop is a skip, without forcing a retry');
      ctx.guards.ungrounded.push('Do you hold a valid police clearance?');
      const unknown = await doFinish(ctx, { status: 'needs_human', reason: 'Unknown required clearance' });
      assert.equal(unknown.kind === 'terminal' && unknown.outcome.status, 'needs-human');
      assert.ok(toolSchemas().some(tool => tool.name === 'get_candidate_evidence'));
      return text;
    })));
    assert.ok(!outputs[0].includes('PRIVATE_ACCOUNT_1'));
    assert.ok(!outputs[1].includes('PRIVATE_ACCOUNT_0'));
    withApplicationModel({ APPLICATION_AI_MODEL: 'celeris' }, () => assert.ok(!toolSchemas().some(tool => tool.name === 'get_candidate_evidence')));
  } finally { dirs.forEach(directory => rmSync(directory, { recursive: true, force: true })); }
});

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const environment = { APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'fictional-private-key', COST_TRACKING: 'false' };
const request: CelerisRequest = { model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Synthetic question.' }], thinking: true, reasoningEffort: 'low' };
const response = (content: unknown[], stop_reason = 'end_turn') => Response.json({ content, stop_reason,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 50 } });

test('both navigators include offered optional letters and preserve suitable existing ones without a no-letter gate', () => {
  for (const model of ['haiku', 'celeris']) withApplicationModel({ APPLICATION_AI_MODEL: model }, () => {
    const prompt = systemPrompt();
    assert.match(prompt, /Include a tailored cover letter wherever the application offers[\s\S]*even when the employer marks it optional/);
    assert.match(prompt, /On Indeed's review page, inspect Supporting documents/);
    assert.match(prompt, /keep it when it suits this role and employer/);
    assert.ok(toolSchemas().every(tool => !Object.prototype.hasOwnProperty.call(tool.parameters.properties ?? {}, 'no_cover_letter_place')));
  });
});

test('single-block letters gain model-chosen paragraphs without changing wording; formatted letters need no extra call', async () => {
  const pieces = ['Dear Hiring Team,', 'I handled payments and supported customers for four years.', 'I would welcome the opportunity to join Example Shop.', 'Kind regards,\nSynthetic Applicant'];
  const dense = pieces.join(' ').replace(/\n/g, ' ');
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(JSON.stringify(body), /Keep every word, number, punctuation mark/);
    return response([{ type: 'text', text: JSON.stringify({ paragraphs: pieces }) }]);
  }) as typeof fetch;
  await withApplicationModel(environment, async () => {
    const formatted = await formatCoverLetterParagraphs(dense);
    assert.equal(formatted, pieces.join('\n\n'));
    assert.equal(await formatCoverLetterParagraphs(formatted), formatted);
    assert.equal(calls, 1);
  });
});

test('paragraph repair rejects rewritten claims instead of silently sending a different letter', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return response([{ type: 'text', text: JSON.stringify({ paragraphs: ['I have ten years of experience.', 'Synthetic Applicant'] }) }]);
  }) as typeof fetch;
  await withApplicationModel(environment, () => assert.rejects(() => formatCoverLetterParagraphs('I have four years of experience. Synthetic Applicant'), /changed the wording/));
  assert.equal(calls, 2, 'format repair is bounded');
});

test('Haiku uses its own prompt, tools and native message schema; one-off prompts are not cache writes', () => withApplicationModel(environment, () => {
  const body = haikuBody({ ...request, responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }, 'medium');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal((body.output_config as { effort: string }).effort, 'medium');
  assert.ok(!JSON.stringify(body).includes('cache_control'));
  assert.ok(!JSON.stringify(body).includes('chat_template_kwargs'));
  assert.match(systemPrompt(), /You are Claude Haiku/);
  assert.ok(systemPrompt().includes(APPLICATION_EVIDENCE_RULES), 'navigator uses the same candidate-evidence policy as its answer and verification helpers');
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

test('real answer-batch schemas fit the strict grammar while original dispatch bounds remain enforced', () => withApplicationModel(environment, () => {
  const shared = toolSchemas().find(tool => tool.name === 'answer_questions')!;
  const before = JSON.stringify(shared);
  const native = haikuTools([shared])[0];
  const array = ((native.input_schema as { properties: Record<string, unknown> }).properties.refs) as Record<string, unknown>;
  assert.equal(native.strict, true);
  assert.equal(array.minItems, 1);
  assert.ok(!('maxItems' in array));
  assert.match(String(array.description), /maxItems:/);
  assert.equal(JSON.stringify(shared), before, 'provider conversion must not weaken the shared dispatch schema');
  assert.equal(validHaikuInput({ refs: ['f0'], reason: 'Answer the current page' }, shared.parameters as Record<string, unknown>), true);
  assert.equal(validHaikuInput({ refs: Array.from({ length: 100 }, (_, i) => `f${i}`), reason: 'Answer the current page' }, shared.parameters as Record<string, unknown>), false);
  assert.equal(validHaikuInput({ refs: [], reason: 'Answer the current page' }, shared.parameters as Record<string, unknown>), false);
  const nested = haikuSchema({ type: 'array', minItems: 3, maxItems: 5, items: { type: 'array', maxItems: 2, items: { type: 'string' } } }) as Record<string, unknown>;
  assert.equal(nested.minItems, 1);
  assert.ok(!('maxItems' in nested));
  assert.ok(!('maxItems' in (nested.items as object)));
}));

test('ranking numeric/text bounds are translated recursively and still checked before accepting output', async () => {
  const schema = { type: 'object', properties: { jobs: { type: 'array', minItems: 1, maxItems: 1, items: {
    type: 'object', properties: { priority: { type: 'integer', minimum: 0, maximum: 100 },
      reason: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['priority', 'reason'],
  } } }, required: ['jobs'] };
  const before = JSON.stringify(schema);
  const native = haikuSchema(schema) as typeof schema;
  assert.ok(!('minimum' in native.properties.jobs.items.properties.priority));
  assert.ok(!('maximum' in native.properties.jobs.items.properties.priority));
  assert.ok(!('maxLength' in native.properties.jobs.items.properties.reason));
  assert.match(String((native.properties.jobs.items.properties.priority as unknown as {description: string}).description), /minimum: 0; maximum: 100/);
  assert.equal(JSON.stringify(schema), before);
  assert.equal(validHaikuInput({jobs: [{priority: 90, reason: 'Fits'}]}, schema), true);
  for (const invalid of [
    {jobs: [{priority: -1, reason: 'Fits'}]}, {jobs: [{priority: 101, reason: 'Fits'}]},
    {jobs: [{priority: 50.5, reason: 'Fits'}]}, {jobs: [{priority: 90, reason: ''}]},
    {jobs: [{priority: 90, reason: 'x'.repeat(121)}]}, {jobs: []},
  ]) assert.equal(validHaikuInput(invalid, schema), false);
  assert.equal(validHaikuInput(0.3, {type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1}), true);
  assert.equal(validHaikuInput(1, {type: 'number', exclusiveMaximum: 1}), false);
  const efforts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); efforts.push(body.output_config.effort);
    return response([{type: 'text', text: JSON.stringify({jobs: [{priority: efforts.length === 1 ? 101 : 90, reason: 'Fits'}]})}]);
  }) as typeof fetch;
  await withApplicationModel(environment, async () => {
    const result = await celerisChat({...request, responseSchema: schema});
    assert.equal(JSON.parse(result.text!).jobs[0].priority, 90);
    assert.deepEqual(efforts, ['medium', 'high']);
  });
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

test('a rejected letter is revised at high effort and replaces the cached draft for later form steps', async () => {
  const profile = { name: 'Synthetic Revision', phone: '', email: 'fixture@example.test', nationality: '', expectedSalary: '', noticePeriod: '',
    willingToRelocate: false, experienceSummary: 'Four years of TypeScript development.', skills: ['TypeScript'], excludedDomains: [], securityClearance: '' };
  const job = { id: 'synthetic-letter-revision', title: 'Developer', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid' };
  let drafts = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt = JSON.stringify(body.messages);
    if (prompt.includes('Check factual claims in this letter')) return response([{ type: 'text', text: '{"supported":true,"reason":"Synthetic evidence check"}' }]);
    drafts++;
    if (drafts === 2) {
      assert.match(prompt, /REVISION REQUIRED/);
      assert.match(prompt, /Remove the unsupported on-time delivery claim/);
      assert.equal(body.output_config.effort, 'high');
    }
    return response([{ type: 'text', text: JSON.stringify({ letter: drafts === 1 ? 'Original synthetic letter.\n\nSynthetic Revision' : 'Revised synthetic letter.\n\nSynthetic Revision' }) }]);
  }) as typeof fetch;
  await withApplicationModel(environment, async () => {
    const original = await finishedCoverLetterForJob(job, profile);
    const repaired = await finishedCoverLetterForJob(job, profile, { draft: original, feedback: 'Remove the unsupported on-time delivery claim.' });
    assert.notEqual(repaired, original);
    assert.equal(await finishedCoverLetterForJob(job, profile), repaired);
    assert.equal(drafts, 2, 'later form steps reuse the corrected letter without redrafting');
  });
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
