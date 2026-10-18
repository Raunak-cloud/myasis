import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { applicationModelIdentity, applicationModelAvailable, applicationModelEnvironment,
  assertApplicationModelConfigured, assertApplicationBrowserConfigured, withApplicationModel } from './application-model.js';
import { config } from './config.js';

test('application AI has one credential-free Celeris identity', () => {
  assert.deepEqual(applicationModelIdentity(), {
    selection: 'celeris', model: 'celeris', protocol: 'celeris-chat-v1', provider: 'Celeris',
  });
});

test('application AI requires a nonempty Celeris credential', () => {
  for (const env of [{}, { CELERIS_API_KEY: '' }, { CELERIS_API_KEY: '  ' }]) {
    assert.equal(applicationModelAvailable(env), false);
    assert.throws(() => assertApplicationModelConfigured(env), /CELERIS_API_KEY/);
    assert.throws(() => assertApplicationBrowserConfigured(env), /CELERIS_API_KEY/);
  }
  assert.equal(applicationModelAvailable({ CELERIS_API_KEY: 'fictional-key' }), true);
  assert.doesNotThrow(() => assertApplicationBrowserConfigured({ CELERIS_API_KEY: 'fictional-key' }));
});

test('Haiku has a separate identity and requires its own scoped credential', () => {
  const env = { APPLICATION_AI_MODEL: 'haiku', ANTHROPIC_API_KEY: 'fictional' };
  assert.equal(applicationModelIdentity(env).model, 'claude-haiku-5-5');
  assert.equal(applicationModelAvailable(env), true);
  assert.equal(applicationModelAvailable({ APPLICATION_AI_MODEL: 'haiku', CELERIS_API_KEY: 'not-a-fallback' }), false);
  assert.throws(() => assertApplicationModelConfigured({ APPLICATION_AI_MODEL: 'haiku' }), /ANTHROPIC_API_KEY/);
});

test('concurrent account scopes isolate credentials and data directories across awaits', async () => {
  const originalData = process.env.DATA_DIR, originalKey = process.env.CELERIS_API_KEY;
  const accounts = ['one', 'two'];
  const results = await Promise.all(accounts.map((owner, index) => withApplicationModel({
    DATA_DIR: resolve('fixture-accounts', owner), CELERIS_API_KEY: 'fictional-' + owner,
  }, async () => {
    const expectedDirectory = resolve('fixture-accounts', owner);
    assert.equal(config.dataDir, expectedDirectory);
    await new Promise(done => setTimeout(done, index ? 1 : 10));
    assert.equal(config.dataDir, expectedDirectory);
    assert.ok(applicationModelEnvironment().CELERIS_API_KEY === 'fictional-' + owner);
    return config.dataDir;
  })));
  assert.notEqual(results[0], results[1]);
  assert.ok(process.env.DATA_DIR === originalData && process.env.CELERIS_API_KEY === originalKey);
});

test('missing scoped credentials never fall back to another process or account credential', async () => {
  await withApplicationModel({ CELERIS_API_KEY: 'fictional-outer' }, async () => {
    assert.equal(applicationModelAvailable(), true);
    await withApplicationModel({}, async () => {
      await Promise.resolve();
      assert.equal(applicationModelAvailable(), false);
      assert.throws(() => assertApplicationModelConfigured(), /CELERIS_API_KEY/);
    });
    assert.equal(applicationModelAvailable(), true);
  });
});

test('request environments are immutable snapshots and nested failures restore their parent', async () => {
  const environment = { DATA_DIR: resolve('fixture-accounts', 'snapshot'), CELERIS_API_KEY: 'fictional-original' };
  await withApplicationModel(environment, async () => {
    environment.CELERIS_API_KEY = 'fictional-later';
    environment.DATA_DIR = resolve('fixture-accounts', 'changed');
    await Promise.resolve();
    assert.ok(applicationModelEnvironment().CELERIS_API_KEY === 'fictional-original');
    assert.equal(config.dataDir, resolve('fixture-accounts', 'snapshot'));
    assert.equal(Object.isFrozen(applicationModelEnvironment()), true);
    assert.throws(() => withApplicationModel({ DATA_DIR: resolve('fixture-accounts', 'nested') }, () => {
      throw new Error('fictional nested failure');
    }), /fictional nested failure/);
    assert.equal(config.dataDir, resolve('fixture-accounts', 'snapshot'));
  });
});
