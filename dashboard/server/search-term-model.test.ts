import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { askApplicationModelForJson, renewSearchTermsAfterSparseRun } from './search-terms.js';
import { getPool } from './db/index.js';
import { userDir, userResumeDir } from './userdata.js';

test('selected search generation uses native Haiku, keeps request scopes separate and retains the run snapshot', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'owtomate-search-model-'));
  const ownerId = `search-model-${randomUUID()}`;
  const resumeDirectory = userResumeDir(ownerId);
  mkdirSync(resumeDirectory, { recursive: true });
  writeFileSync(join(resumeDirectory, 'fixture.txt'), 'Fixture candidate has customer service and retail checkout experience.');
  const keys = ['DATA_DIR', 'COST_TRACKING', 'ADMIN_EMAILS', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'CELERIS_API_KEY', 'CELERIS_BASE_URL', 'APPLICATION_AI_MODEL'] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DATA_DIR = temporary;
  process.env.COST_TRACKING = 'false';
  process.env.ADMIN_EMAILS = 'admin@example.test';
  process.env.ANTHROPIC_API_KEY = 'fixture-native-key';
  process.env.OPENROUTER_API_KEY = '';
  process.env.CELERIS_API_KEY = 'fixture-celeris-key';
  process.env.CELERIS_BASE_URL = 'https://celeris.fixture.invalid';
  process.env.APPLICATION_AI_MODEL = 'celeris';
  const pool = getPool();
  t.after(async () => {
    await pool.end();
    unlinkSync(join(resumeDirectory, 'fixture.txt'));
    rmdirSync(resumeDirectory);
    rmdirSync(userDir(ownerId));
    for (const file of readdirSync(temporary)) unlinkSync(join(temporary, file));
    rmdirSync(temporary);
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });

  let currentSavedModel = 'celeris';
  const writes: unknown[][] = [];
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    assert.equal(params[0], ownerId);
    if (/FROM users u/.test(sql)) {
      assert.match(sql, /u.blocked_at IS NULL/);
      return { rows: [{ email: 'admin@example.test', applicationAiModel: currentSavedModel }] };
    }
    if (/FROM resumes/.test(sql)) return { rows: [{
      id: 'fixture-resume', label: 'Fixture resume', file_name: 'fixture.txt', seek_name: null,
      size_bytes: 90, is_default: true, notes: '', uploaded_at: new Date(),
    }] };
    assert.match(sql, /UPDATE settings/);
    assert.equal(params[1], 'retail assistant');
    writes.push(params);
    return { rows: [{ value: params[2] }] };
  });

  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let nativeFailure = false;
  const generatedSearches = { searches: [{
    query: 'customer service', resumeEvidence: ['Customer service and checkout experience'],
    whySomeoneWouldSearchIt: 'Common wording for supported retail work',
    australianCredentialRequired: '', australianCredentialEvidence: '',
  }] };
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (String(url).startsWith('https://celeris.fixture.invalid/')) {
      assert.equal(body.model, 'celeris-1-magnus');
      assert.ok(body.response_format);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ result: 'celeris' }) } }] });
    }
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.ok(Array.isArray(body.system));
    assert.ok(body.output_config, 'native structured output is requested');
    assert.equal(body.response_format, undefined, 'OpenAI-only response format must not reach Haiku');
    if (nativeFailure) return Response.json({ error: { message: 'Fixture rejected' } }, { status: 402 });
    return Response.json({ model: 'claude-haiku-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(generatedSearches) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  const nativeEnvironment = {
    ...process.env, APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true',
    APPLICATION_AI_OWNER_ID: ownerId, DATA_DIR: userDir(ownerId),
  };
  const [native, celeris] = await Promise.all([
    askApplicationModelForJson(nativeEnvironment, 'NATIVE_PRIVATE_SYSTEM', 'Native search request'),
    askApplicationModelForJson({ APPLICATION_AI_MODEL: 'celeris' }, 'CELERIS_PRIVATE_SYSTEM', 'Celeris search request', {
      type: 'object', properties: { result: { type: 'string' } }, required: ['result'],
    }),
  ]);
  assert.equal(native.ok, true, native.error);
  assert.equal(celeris.ok, true, celeris.error);
  assert.equal(process.env.APPLICATION_AI_MODEL, 'celeris', 'the request must not change global selection');
  assert.equal(calls.filter(call => call.url.includes('anthropic.com')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('celeris.fixture')).length, 1);
  assert.ok(!JSON.stringify(calls.find(call => call.url.includes('anthropic.com'))!.body).includes('CELERIS_PRIVATE_SYSTEM'));
  assert.ok(!JSON.stringify(calls.find(call => call.url.includes('celeris.fixture'))!.body).includes('NATIVE_PRIVATE_SYSTEM'));

  // Saved settings changed after this run began; its captured Haiku selection wins.
  currentSavedModel = 'celeris';
  const beforeRenewal = calls.length;
  const renewed = await renewSearchTermsAfterSparseRun(ownerId, 'retail assistant', 'retail assistant', 'haiku');
  assert.deepEqual(renewed, { status: 'renewed', terms: ['customer service'] });
  assert.deepEqual(writes, [[ownerId, 'retail assistant', 'customer service']]);
  assert.ok(calls.slice(beforeRenewal).every(call => call.url === 'https://api.anthropic.com/v1/messages'));

  nativeFailure = true;
  const beforeFailure = calls.length;
  const failed = await askApplicationModelForJson(nativeEnvironment, 'Fixture system', 'Fixture request');
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /Claude Haiku 5.5 request failed/);
  assert.ok(calls.slice(beforeFailure).every(call => call.url === 'https://api.anthropic.com/v1/messages'), 'Haiku failure must never fall back to Celeris');
  const beforeInvalid = calls.length;
  assert.equal((await askApplicationModelForJson({ APPLICATION_AI_MODEL: 'mimo' }, 'Fixture system', 'Fixture request')).ok, false);
  assert.equal(calls.length, beforeInvalid, 'invalid selections must not make any provider request');
});
