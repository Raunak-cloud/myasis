import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationModel, applicationModelIdentity, applicationModelAvailable,
  assertApplicationModelConfigured, applicationHaikuRoute, withApplicationModel } from './application-model.js';

const root = resolve('fixture-bot');
const haiku = { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true',
  APPLICATION_AI_OWNER_ID: 'admin-one', DATA_DIR: resolve(root, 'data/users/admin-one'),
  OPENROUTER_API_KEY: 'fixture-router' };

test('only the two supported run-wide models are accepted', () => {
  assert.equal(applicationModel({}, root), 'celeris');
  assert.equal(applicationModel(haiku, root), 'haiku');
  for (const name of ['mimo', 'seed', 'ling', 'luna', '', 'Haiku']) {
    assert.throws(() => applicationModel({ ...haiku, APPLICATION_AI_MODEL: name }, root), /Unsupported application AI model/);
  }
});

test('Haiku cannot cross the admin or account-directory boundary', () => {
  for (const patch of [{ APPLICATION_AI_ADMIN_ENABLED: 'false' }, { APPLICATION_AI_OWNER_ID: '' },
    { APPLICATION_AI_OWNER_ID: '../admin-one' }, { DATA_DIR: resolve(root, 'data/users/someone-else') }]) {
    assert.throws(() => applicationModel({ ...haiku, ...patch }, root), /authenticated admin/);
  }
});

test('explicit Celeris ignores retired browser-only model flags', () => {
  assert.equal(applicationModel({ APPLICATION_AI_MODEL: 'celeris', ADMIN_BROWSER_MODEL_PILOT: 'mimo' }, root), 'celeris');
});

test('Haiku requires its selected provider key, never a Celeris fallback', () => {
  const missing = { ...haiku, OPENROUTER_API_KEY: '', CELERIS_API_KEY: 'native-key' };
  assert.equal(applicationModelAvailable(missing, root), false);
  assert.throws(() => assertApplicationModelConfigured(missing, root), /No other model will be used/);
  assert.equal(applicationModelAvailable(haiku, root), true);
  assert.equal(applicationHaikuRoute(haiku, root).endpoint, 'https://openrouter.ai/api/v1/messages');
  assert.equal(applicationHaikuRoute({ ...haiku, ANTHROPIC_API_KEY: 'direct' }, root).model, 'claude-haiku-5-5');
});

test('cache identity distinguishes model and protocol without containing credentials', () => {
  const identity = JSON.stringify(applicationModelIdentity(haiku, root));
  assert.match(identity, /anthropic-messages/);
  assert.doesNotMatch(identity, /fixture-router/);
  assert.notEqual(identity, JSON.stringify(applicationModelIdentity({ APPLICATION_AI_MODEL: 'celeris' }, root)));
});

test('concurrent request-scoped choices do not mutate or leak through process.env', async () => {
  const original = process.env.APPLICATION_AI_MODEL;
  const results = await Promise.all([
    withApplicationModel({ ...haiku, DATA_DIR: resolve(fileURLToPath(new URL('../', import.meta.url)), 'data/users/admin-one') }, async () => {
      await new Promise(r => setTimeout(r, 10));
      return applicationModel();
    }),
    withApplicationModel({ APPLICATION_AI_MODEL: 'celeris' }, async () => {
      await Promise.resolve();
      return applicationModel();
    }),
  ]);
  assert.deepEqual(results, ['haiku', 'celeris']);
  assert.equal(process.env.APPLICATION_AI_MODEL, original);
});
