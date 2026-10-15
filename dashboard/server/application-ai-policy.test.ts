import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { APPLICATION_AI_MODELS } from '../src/application-ai-model.js';
import {
  applicationAiConfigurationError, applicationAiModel, applicationAiSettingsError,
  applicationAiSettingsMetadata,
} from './application-ai-policy.js';
import { applyRunPolicy, mayEditRunSetting } from './entitlements.js';
import { accountApplicationAiEnvironment } from './runner.js';
import { getPool } from './db/index.js';
import { saveUserSettings } from './settings.js';
import { startRun } from './start-run.js';

const pool = getPool();
after(async () => { await pool.end(); });

test('the application selector has exactly two models and rejects explicit unsupported values', () => {
  assert.deepEqual(APPLICATION_AI_MODELS, [
    { value: 'celeris', label: 'Celeris' },
    { value: 'haiku', label: 'Claude Haiku 5.5' },
  ]);
  assert.equal(applicationAiModel(undefined), 'celeris');
  for (const model of ['celeris', 'haiku']) {
    assert.equal(applicationAiModel(model), model);
    assert.equal(applicationAiSettingsError({ APPLICATION_AI_MODEL: model }, true), null);
    assert.equal(applicationAiSettingsError({ APPLICATION_AI_MODEL: model }, false)?.status, 403);
  }
  for (const value of ['', 'Haiku', 'mimo', 'seed', 'luna', null, true, 1, {}, []]) {
    assert.throws(() => applicationAiModel(value), /Choose Celeris or Claude Haiku 5.5/);
    assert.equal(applicationAiSettingsError({ APPLICATION_AI_MODEL: value }, true)?.status, 400);
  }
  assert.equal(applicationAiSettingsError({ KEYWORDS: 'retail' }, false), null);
});

test('model access stays administrator-only even on plans with fine tuning', () => {
  const common = { fineTune: true, advancedFilters: true, indeedApplications: true, evaluationsPerRun: null, humanizer: true, maxApplicationsPerRunOverride: null };
  for (const tier of ['standard', 'intensive', 'admin'] as const) {
    assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { ...common, tier }), tier === 'admin');
    for (const trigger of ['manual', 'auto'] as const) {
      assert.equal(applyRunPolicy({ APPLICATION_AI_MODEL: 'haiku' }, { ...common, tier }, trigger).APPLICATION_AI_MODEL,
        tier === 'admin' ? 'haiku' : 'celeris');
    }
  }
});

test('run requests reject unauthorized or unsupported selections before preparing account data', async () => {
  const originalQuery = pool.query, originalAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.test';
  pool.query = (async () => { throw new Error('A rejected request must not query or change account data.'); }) as typeof originalQuery;
  try {
    for (const trigger of ['manual', 'auto', 'admin', 'onboarding'] as const) {
      const result = await startRun({ userId: 'owner-account', email: 'customer@example.test', mode: 'live', trigger,
        clientOverrides: { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true' } });
      assert.equal(result.ok, false);
      assert.equal('status' in result && result.status, 403);
    }
    const result = await startRun({ userId: 'owner-account', email: 'admin@example.test', mode: 'live', trigger: 'manual',
      clientOverrides: { APPLICATION_AI_MODEL: 'mimo' } });
    assert.equal(result.ok, false);
    assert.equal('status' in result && result.status, 400);
  } finally {
    pool.query = originalQuery;
    if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = originalAdmins;
  }
});

test('availability metadata reveals only configuration status and never provider credentials', () => {
  const saved = { APPLICATION_AI_MODEL: 'haiku' };
  const env = { ANTHROPIC_API_KEY: 'test-anthropic-secret', OPENROUTER_API_KEY: 'test-openrouter-secret' };
  assert.deepEqual(applicationAiSettingsMetadata(saved, true, env), {
    APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_HAIKU_CONFIGURED: 'true', APPLICATION_AI_CELERIS_CONFIGURED: 'false',
  });
  assert.deepEqual(applicationAiSettingsMetadata(saved, false, env), { APPLICATION_AI_MODEL: 'celeris' });
  assert.deepEqual(applicationAiSettingsMetadata({}, true, {}), {
    APPLICATION_AI_MODEL: 'celeris', APPLICATION_AI_HAIKU_CONFIGURED: 'false', APPLICATION_AI_CELERIS_CONFIGURED: 'false',
  });
  assert.equal(applicationAiConfigurationError('celeris', {}), null);
  assert.match(applicationAiConfigurationError('celeris', {}, true)!, /Celeris is not configured/);
  assert.equal(applicationAiConfigurationError('celeris', { CELERIS_API_KEY: 'test-key' }, true), null);
  assert.match(applicationAiConfigurationError('haiku', {})!, /not configured/);
  assert.match(applicationAiConfigurationError('haiku', { ANTHROPIC_API_KEY: ' ', OPENROUTER_API_KEY: '' })!, /not configured/);
  assert.equal(applicationAiConfigurationError('haiku', { ANTHROPIC_API_KEY: 'test-key' }), null);
  assert.equal(applicationAiConfigurationError('haiku', { OPENROUTER_API_KEY: 'test-key' }), null);
});

test('direct saved-setting writes validate owner and enum before any update', async () => {
  const originalQuery = pool.query, originalAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.test';
  let email = 'customer@example.test';
  const writes: unknown[][] = [];
  const stored: Record<string, string> = {};
  pool.query = (async (sql: string, params: unknown[]) => {
    if (/SELECT email FROM users/.test(sql)) {
      assert.match(sql, /blocked_at IS NULL/);
      assert.deepEqual(params, ['owner-account']);
      return { rows: [{ email }] };
    }
    if (/INSERT INTO settings/.test(sql)) {
      writes.push(params);
      stored[String(params[1])] = String(params[2]);
      return { rows: [] };
    }
    assert.match(sql, /SELECT key, value FROM settings WHERE user_id = \$1/);
    assert.deepEqual(params, ['owner-account']);
    return { rows: Object.entries(stored).map(([key, value]) => ({ key, value })) };
  }) as typeof originalQuery;
  try {
    await assert.rejects(saveUserSettings('owner-account', { KEYWORDS: 'retail', APPLICATION_AI_MODEL: 'haiku' }), /only to administrator/);
    assert.equal(writes.length, 0, 'a rejected selection must not partially save other settings');
    email = 'admin@example.test';
    await assert.rejects(saveUserSettings('owner-account', { KEYWORDS: 'retail', APPLICATION_AI_MODEL: 'mimo' }), /Choose Celeris/);
    assert.equal(writes.length, 0);
    assert.deepEqual(await saveUserSettings('owner-account', { APPLICATION_AI_MODEL: 'haiku' }), { APPLICATION_AI_MODEL: 'haiku' });
    assert.deepEqual(writes, [['owner-account', 'APPLICATION_AI_MODEL', 'haiku']]);
  } finally {
    pool.query = originalQuery;
    if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = originalAdmins;
  }
});

test('worker model policy rechecks the account owner, saved choice and provider configuration', async () => {
  const originalQuery = pool.query;
  const keys = ['ADMIN_EMAILS', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'CELERIS_API_KEY', 'APPLICATION_AI_MODEL'] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ADMIN_EMAILS = 'admin@example.test';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.CELERIS_API_KEY = '';
  // Machine-level experimental choices cannot decide an account's model.
  process.env.APPLICATION_AI_MODEL = 'haiku';
  let owner: { email: string; applicationAiModel: string | null } | undefined;
  pool.query = (async (sql: string, params: unknown[]) => {
    assert.match(sql, /LEFT JOIN settings s ON s.user_id = u.id AND s.key = 'APPLICATION_AI_MODEL'/);
    assert.match(sql, /u.blocked_at IS NULL/);
    assert.deepEqual(params, ['owner-account']);
    return { rows: owner ? [owner] : [] };
  }) as typeof originalQuery;
  try {
    await assert.rejects(accountApplicationAiEnvironment('owner-account'), /account is not available/);
    await assert.rejects(accountApplicationAiEnvironment('../owner-account', 'haiku'), /account is not available/);
    owner = { email: 'customer@example.test', applicationAiModel: null };
    assert.deepEqual(await accountApplicationAiEnvironment('owner-account'), {
      APPLICATION_AI_MODEL: 'celeris', APPLICATION_AI_ADMIN_ENABLED: 'false', APPLICATION_AI_OWNER_ID: 'owner-account',
    });
    await assert.rejects(accountApplicationAiEnvironment('owner-account', 'haiku'), /only to administrator/);
    // Removing an administrator's access also removes an already-saved Haiku choice.
    owner.applicationAiModel = 'haiku';
    assert.equal((await accountApplicationAiEnvironment('owner-account')).APPLICATION_AI_MODEL, 'celeris');
    owner = { email: 'admin@example.test', applicationAiModel: 'haiku' };
    await assert.rejects(accountApplicationAiEnvironment('owner-account'), /not configured/);
    await assert.rejects(accountApplicationAiEnvironment('owner-account', 'celeris'), /Celeris is not configured/);
    process.env.CELERIS_API_KEY = 'test-celeris-key';
    assert.equal((await accountApplicationAiEnvironment('owner-account', 'celeris')).APPLICATION_AI_MODEL, 'celeris');
    await assert.rejects(accountApplicationAiEnvironment('owner-account', 'mimo'), /Choose Celeris/);
    process.env.OPENROUTER_API_KEY = 'test-not-a-real-secret';
    assert.deepEqual(await accountApplicationAiEnvironment('owner-account'), {
      APPLICATION_AI_MODEL: 'haiku', APPLICATION_AI_ADMIN_ENABLED: 'true', APPLICATION_AI_OWNER_ID: 'owner-account',
    });
    owner.applicationAiModel = 'luna';
    await assert.rejects(accountApplicationAiEnvironment('owner-account', 'celeris'), /Choose Celeris/);
  } finally {
    pool.query = originalQuery;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});
