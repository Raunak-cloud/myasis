import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationChat, reviewChat, rankingChat } from './application-chat.js';
import { withApplicationModel } from '../application-model.js';
import { JOB_REVIEW_MODEL } from '../application-model-catalog.js';
import { closeCelerisQueues } from '../../../shared/celeris-queue.mjs';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const request = {
  model: 'celeris-1' as const,
  messages: [{ role: 'user' as const, content: 'Fictional stage test.' }],
  responseSchema: { type: 'object', properties: { decision: { type: 'string' } } },
  maxTokens: 1024,
};

test('Qwen always ranks and reviews while applying retains its own model and key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-stage-routing-'));
  const originalFetch = globalThis.fetch, previousCostTracking = process.env.COST_TRACKING;
  process.env.COST_TRACKING = 'true';
  const calls: Array<{ url: string; key: string; body: any }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get('authorization') ?? '', body: JSON.parse(String(init?.body)) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 } });
  };
  try {
    await Promise.all(['customer', 'operator'].map(owner => withApplicationModel({
      DATA_DIR: join(directory, owner), APPLICATION_AI_MODEL: owner === 'operator' ? 'minimax' : 'celeris',
      CELERIS_API_KEY: owner + '-celeris', OPENROUTER_API_KEY: owner === 'operator' ? owner + '-apply' : '',
      OPENROUTER_JOB_REVIEW_API_KEY: owner + '-review', CELERIS_QUEUE_FILE: join(directory, 'queue.sqlite'), CELERIS_MIN_INTERVAL_MS: '0',
    }, () => Promise.all([reviewChat(request), rankingChat(request), applicationChat(request)]))));
    assert.equal(calls.length, 6);
    for (const owner of ['customer', 'operator']) {
      const matching = calls.filter(call => call.key === `Bearer ${owner}-review`);
      assert.equal(matching.length, 2);
      for (const call of matching) {
        assert.equal(call.url, endpoint);
        assert.equal(call.body.model, JOB_REVIEW_MODEL);
        assert.deepEqual(call.body.reasoning, { enabled: false });
        assert.deepEqual(call.body.response_format, { type: 'json_object' });
        assert.match(call.body.messages[0].content, /JSON schema: .*decision/);
        assert.equal(call.body.provider.require_parameters, true);
        assert.equal(call.body.models, undefined);
      }
      const applying = calls.find(call => call.key === `Bearer ${owner}-${owner === 'operator' ? 'apply' : 'celeris'}`)!;
      assert.equal(applying.body.model, owner === 'operator' ? 'minimax/minimax-m3.1-flash' : 'celeris-1-magnus');
      assert.equal(applying.url === endpoint, owner === 'operator');
      assert.equal(applying.body.response_format.type, 'json_schema');
      const ledger = readFileSync(join(directory, owner, 'cost-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(ledger.filter(entry => entry.kind === 'usage' && entry.model === JOB_REVIEW_MODEL).length, 2);
      assert.equal(ledger.filter(entry => entry.kind === 'usage' && entry.model === applying.body.model).length, 1);
    }
    assert.equal(request.messages.length, 1, 'routing cannot mutate caller messages');
    const before = calls.length;
    await withApplicationModel({ DATA_DIR: directory, CELERIS_API_KEY: 'apply-only' }, async () => {
      await assert.rejects(reviewChat(request), /OPENROUTER_API_KEY/);
      await assert.rejects(rankingChat(request), /OPENROUTER_API_KEY/);
    });
    await withApplicationModel({ DATA_DIR: directory, APPLICATION_AI_MODEL: 'minimax', OPENROUTER_JOB_REVIEW_API_KEY: 'review-only' },
      () => assert.rejects(applicationChat(request), /OPENROUTER_API_KEY/));
    assert.equal(calls.length, before, 'a missing stage credential cannot use another stage’s key');

    let attempts = 0;
    globalThis.fetch = async (url, init) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      assert.equal(String(url), endpoint);
      assert.equal(body.model, JOB_REVIEW_MODEL);
      return attempts === 1
        ? Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{' } }] })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] });
    };
    await withApplicationModel({ DATA_DIR: directory, OPENROUTER_API_KEY: 'review-default' }, () => reviewChat(request));
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    closeCelerisQueues();
    rmSync(directory, { recursive: true, force: true });
    if (previousCostTracking === undefined) delete process.env.COST_TRACKING;
    else process.env.COST_TRACKING = previousCostTracking;
  }
});
