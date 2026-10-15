import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const owner = `model-route-${randomUUID()}`;
const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'data/users', owner);
Object.assign(process.env, { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true',
  APPLICATION_AI_OWNER_ID: owner, DATA_DIR: directory, OPENROUTER_API_KEY: 'fixture-openrouter',
  ANTHROPIC_API_KEY: '', CELERIS_API_KEY: 'fixture-celeris', COST_TRACKING: 'false', HUMANIZER_MODE: 'always' });
const { celerisChat } = await import('./celeris.js');
const { withApplicationModel } = await import('../application-model.js');
const { humanizeCoverLetter, assertHumanizerHealthy } = await import('../humanizer.js');
const { systemPrompt } = await import('./loop/prompt.js');
const { checkpointTranscript } = await import('./loop/transcript.js');
const originalFetch = globalThis.fetch;

test('every call shape follows the selected model, including recovery, checks and prose editing', async () => {
  const seen: Array<{ url: string; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body)); seen.push({ url, body });
    if (url.includes('openrouter.ai')) {
      const content = body.tools
        ? [{ type: 'thinking', thinking: '', signature: 'fixture-signature' }, { type: 'tool_use', id: `call-${seen.length}`, name: 'take_snapshot', input: {} }]
        : [{ type: 'text', text: body.output_config.format ? '{"ok":true}' : 'I would welcome the chance to help customers and support your retail team. My experience includes serving customers, handling payments and keeping stock organised.' }];
      return new Response(JSON.stringify({ model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic',
        stop_reason: body.tools ? 'tool_use' : 'end_turn', content,
        usage: { input_tokens: 100, output_tokens: 20, cost: .001 } }));
    }
    assert.match(url, /inference\.celeris\.ai\/celeris-1-magnus\/v1\/chat\/completions$/);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Celeris result' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
  }) as typeof fetch;
  try {
    for (const stage of ['screening', 'ranking', 'cv-choice', 'cover-letter', 'answer', 'saved-form-check', 'receipt', 'identity', 'blocker', 'lesson']) {
      const result = await celerisChat({ model: stage === 'screening' ? 'celeris-1' : 'celeris-1-magnus',
        messages: [{ role: 'user', content: `Fictional ${stage} fixture` }],
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        ...(stage === 'answer' ? { purpose: 'grounded-answer' as const } : {}), thinking: true });
      assert.equal(result.text, '{"ok":true}');
    }
    for (const recovery of [false, true]) {
      const reply = await celerisChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Fictional browser page' }],
        tools: [{ name: 'take_snapshot', description: 'Read the page', parameters: { type: 'object', properties: {} } }],
        requireTool: true, thinking: true, reasoningEffort: recovery ? 'xhigh' : 'low' });
      assert.equal(reply.toolCalls[0].name, 'take_snapshot');
      assert.ok(reply.message.role === 'assistant' && reply.message.anthropic_content);
    }
    await assertHumanizerHealthy();
    await humanizeCoverLetter('I have experience helping customers, taking payments and organising stock. I would like to bring these skills to your retail team.', undefined, true);
    assert.equal(seen.length, 13);
    for (const call of seen) {
      assert.equal(call.url, 'https://openrouter.ai/api/v1/messages');
      assert.equal(call.body.model, 'anthropic/claude-haiku-5.5');
      assert.deepEqual(call.body.thinking, { type: 'adaptive' });
      assert.equal(call.body.chat_template_kwargs, undefined);
      assert.equal(call.body.temperature, undefined);
      assert.deepEqual(call.body.provider.only, ['anthropic']);
    }
    assert.doesNotMatch(systemPrompt(), /Magnus/);
    assert.match(systemPrompt(), /this same Haiku model/);
    await withApplicationModel({ APPLICATION_AI_MODEL: 'celeris' }, () => celerisChat({ model: 'celeris-1-magnus', messages: [{ role: 'user', content: 'Celeris fixture' }] }));
    assert.match(seen.at(-1)!.url, /inference\.celeris\.ai/);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('native transcript rollover discards all old signed assistant blocks and retains submission uncertainty', () => {
  const messages: Parameters<typeof checkpointTranscript>[0] = [{ role: 'system', content: 'Haiku instructions' },
    { role: 'user', content: 'Application identity' }, { role: 'assistant', content: 'x'.repeat(500), anthropic_content: [{ type: 'thinking', signature: 'fixture' }] },
    { role: 'user', content: 'Current page' }];
  const next = checkpointTranscript(messages, 10, { submissionAttempted: true });
  assert.equal(next.some(m => m.role === 'assistant'), false);
  assert.match(JSON.stringify(next), /submissionAttempted.*true/);
  assert.equal(messages[2].role, 'assistant');
});
