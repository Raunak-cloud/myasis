import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { applicationModelIdentity, applicationModelAvailable, applicationModelEnvironment,
  assertApplicationModelConfigured, assertApplicationBrowserConfigured, applicationAgentIdentity, reviewModelIdentity, reviewModelAvailable, assertReviewModelConfigured, withApplicationModel } from './application-model.js';
import { config } from './config.js';

test('default application and review identities are independent and credential-free', () => {
  for(const value of [undefined,'retired','minimax']) {
    assert.equal(applicationModelIdentity({APPLICATION_AI_MODEL:value}).model,'minimax/minimax-m3.1-flash');
  }
  assert.equal(reviewModelIdentity().model,'celeris-1-magnus');
  assert.equal(applicationAgentIdentity().provider,'OpenRouter');
  assert.equal(applicationModelAvailable({CELERIS_API_KEY:'fixture'}),false);
  assert.equal(reviewModelAvailable({OPENROUTER_API_KEY:'fixture'}),false);
});
test('a full browser run needs both stage credentials, without fallback', () => {
  for(const env of [{}, {CELERIS_API_KEY:'fixture'}, {OPENROUTER_API_KEY:'fixture'}, {CELERIS_API_KEY:' ',OPENROUTER_API_KEY:'fixture'}]) {
    assert.throws(()=>assertApplicationBrowserConfigured(env),/API_KEY/);
  }
  assert.doesNotThrow(()=>assertApplicationBrowserConfigured({CELERIS_API_KEY:'review',OPENROUTER_API_KEY:'apply'}));
  assert.throws(()=>assertReviewModelConfigured({}),/Magnus job review/);
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
  await withApplicationModel({ OPENROUTER_API_KEY: 'fictional-outer' }, async () => {
    assert.equal(applicationModelAvailable(), true);
    await withApplicationModel({}, async () => {
      await Promise.resolve();
      assert.equal(applicationModelAvailable(), false);
      assert.throws(() => assertApplicationModelConfigured(), /OPENROUTER_API_KEY/);
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
