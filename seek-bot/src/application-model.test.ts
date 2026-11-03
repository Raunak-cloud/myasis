import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { applicationModelAvailable, applicationModelEnvironment,
  assertApplicationModelConfigured, assertApplicationBrowserConfigured, applicationAgentIdentity, reviewModelIdentity, reviewModelAvailable, assertReviewModelConfigured, withApplicationModel } from './application-model.js';
import { config } from './config.js';

test('Magnus is the default; authorized MiniMax selection covers review and applications', () => {
  for (const value of [undefined, 'retired', 'celeris']) {
    assert.equal(applicationAgentIdentity({APPLICATION_AI_MODEL:value}).model,'celeris-1-magnus');
  }
  assert.equal(applicationAgentIdentity({APPLICATION_AI_MODEL:'minimax'}).model,'minimax/minimax-m3.1-flash');
  assert.equal(reviewModelIdentity().model,'celeris-1-magnus');
  assert.equal(reviewModelIdentity({APPLICATION_AI_MODEL:'minimax'}).model,'minimax/minimax-m3.1-flash');
  assert.equal(applicationAgentIdentity({APPLICATION_AI_MODEL:'deepseek'}).model,'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(reviewModelIdentity({APPLICATION_AI_MODEL:'deepseek'}).model,'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(applicationModelAvailable({CELERIS_API_KEY:'fixture'}),true);
  assert.equal(applicationModelAvailable({OPENROUTER_API_KEY:'fixture'}),false);
  assert.equal(reviewModelAvailable({OPENROUTER_API_KEY:'fixture'}),false);
});

test('each whole-run provider needs only its own credential without fallback', () => {
  for (const env of [{}, {OPENROUTER_API_KEY:'fixture'}, {CELERIS_API_KEY:' '}]) {
    assert.throws(()=>assertApplicationBrowserConfigured(env),/API_KEY/);
  }
  assert.doesNotThrow(()=>assertApplicationBrowserConfigured({CELERIS_API_KEY:'review-and-apply'}));
  assert.throws(()=>assertApplicationBrowserConfigured({APPLICATION_AI_MODEL:'minimax',CELERIS_API_KEY:'review'}),/OPENROUTER_API_KEY/);
  assert.doesNotThrow(()=>assertApplicationBrowserConfigured({APPLICATION_AI_MODEL:'minimax',CELERIS_API_KEY:'review',OPENROUTER_API_KEY:'apply'}));
  assert.doesNotThrow(()=>assertApplicationBrowserConfigured({APPLICATION_AI_MODEL:'minimax',OPENROUTER_API_KEY:'apply'}));
  assert.throws(()=>assertReviewModelConfigured({}),/CELERIS_API_KEY.*job review/);
  assert.throws(()=>assertReviewModelConfigured({APPLICATION_AI_MODEL:'minimax',CELERIS_API_KEY:'unused'}),/OPENROUTER_API_KEY/);
  assert.throws(()=>assertApplicationBrowserConfigured({APPLICATION_AI_MODEL:'deepseek',CELERIS_API_KEY:'unused'}),/OPENROUTER_API_KEY/);
  assert.doesNotThrow(()=>assertApplicationBrowserConfigured({APPLICATION_AI_MODEL:'deepseek',OPENROUTER_API_KEY:'fixture'}));
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
  await withApplicationModel({ APPLICATION_AI_MODEL:'minimax', OPENROUTER_API_KEY: 'fictional-outer' }, async () => {
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
