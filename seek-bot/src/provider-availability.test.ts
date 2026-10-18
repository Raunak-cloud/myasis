import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicSpendLimit, assertApplicationProviderReady, assertProviderReady, blockProviderBudget, ProviderBudgetError } from './provider-availability.js';
import { withApplicationModel } from './application-model.js';

test('documented workspace and organization limits are distinguished from malformed requests and rate limits', () => {
  const error = (message: string, type = 'invalid_request_error') => JSON.stringify({ error: { type, message } });
  assert.equal(anthropicSpendLimit(400, error('You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.')), 'workspace');
  assert.equal(anthropicSpendLimit(400, error('You have reached your specified API usage limits.')), 'organization');
  assert.equal(anthropicSpendLimit(429, error('Rate limit exceeded', 'rate_limit_error')), null);
  assert.equal(anthropicSpendLimit(400, error('messages.1: invalid tool input')), null);
  assert.equal(anthropicSpendLimit(400, error('A quoted prompt says You have reached your specified workspace API usage limits.')), null);
  assert.equal(anthropicSpendLimit(400, 'not JSON'), null);
});

test('one exhausted key stops subsequent work without blocking another key or model, and can be probed after expiry', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const error = blockProviderBudget('Anthropic', 'synthetic-private-key-a', 'workspace');
  assert.ok(error instanceof ProviderBudgetError);
  assert.match(error.message, /workspace API spending limit reached/);
  assert.ok(!error.message.includes('synthetic-private-key'));
  assert.throws(() => withApplicationModel({ APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'synthetic-private-key-a' }, assertApplicationProviderReady), ProviderBudgetError);
  assert.doesNotThrow(() => assertProviderReady('Anthropic', 'synthetic-private-key-b'));
  assert.doesNotThrow(() => withApplicationModel({ CELERIS_API_KEY: 'synthetic-private-key-a' }, assertApplicationProviderReady));
  now += 60_000;
  assert.doesNotThrow(() => assertProviderReady('Anthropic', 'synthetic-private-key-a'));
});
