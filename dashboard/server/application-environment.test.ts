import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { accountApplicationEnvironment, applicationRunEnvironment } from './runner.js';
import { getPool } from './db/index.js';
import { loadUserSettings, runSettingsForUser, saveUserSettings } from './settings.js';
import { userDir } from './userdata.js';

const pool = getPool();
after(async () => { await pool.end(); });

test('worker environment excludes retired controls and unknown credentials without mutating its input', () => {
  const input = { PATH: 'fixture-path', DATA_DIR: '/owner/files', CELERIS_API_KEY: 'fixture-key',
    HUMANIZER_API_KEY: 'fixture-rewriter', SITE_AUTH_SECRET: 'fixture-session',
    APPLICATION_AI_MODEL: 'retired', APPLICATION_AI_FORM_REVIEW_MODE: 'retired',
    APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true',
    RETIRED_PROVIDER_API_KEY: 'must-not-inherit', RETIRED_PROVIDER_KEY: 'must-not-inherit', UNRELATED_SECRET: 'must-not-inherit',
    BRIGHTDATA_BROWSER_PASSWORD: 'fixture-browser-password' };
  const before = { ...input };
  assert.deepEqual(applicationRunEnvironment(input), { PATH: 'fixture-path', DATA_DIR: '/owner/files',
    CELERIS_API_KEY: 'fixture-key', SITE_AUTH_SECRET: 'fixture-session',
    BRIGHTDATA_BROWSER_PASSWORD: 'fixture-browser-password' });
  assert.deepEqual(input, before);
});

test('application environment rechecks active ownership and only returns that owner data directory', async () => {
  const originalQuery = pool.query, originalKey = process.env.CELERIS_API_KEY;
  let available = true, queries = 0;
  process.env.CELERIS_API_KEY = 'fixture-only';
  pool.query = (async (sql: string, params: unknown[]) => {
    queries++;
    assert.match(sql, /FROM users WHERE id = \$1 AND blocked_at IS NULL/);
    assert.deepEqual(params, ['owner-account']);
    return { rows: available ? [{ id: 'owner-account' }] : [] };
  }) as typeof originalQuery;
  try {
    await assert.rejects(accountApplicationEnvironment('../owner-account'), /account is not available/);
    assert.equal(queries, 0);
    assert.deepEqual(await accountApplicationEnvironment('owner-account', {}), { DATA_DIR: userDir('owner-account'), APPLICATION_AI_MODEL: 'celeris', APPLICATION_AGENT_MODE: 'protected', APPLICATION_AGENT_MODE_AUTHORIZED: 'false', CELERIS_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: '' });
    available = false;
    await assert.rejects(accountApplicationEnvironment('owner-account', {}), /account is not available/);
    available = true;
    process.env.CELERIS_API_KEY = '';
    await assert.rejects(accountApplicationEnvironment('owner-account', {}), /Celeris is not configured/);
  } finally {
    pool.query = originalQuery;
    if (originalKey === undefined) delete process.env.CELERIS_API_KEY; else process.env.CELERIS_API_KEY = originalKey;
  }
});

test('runtime selection rechecks admin status and excludes the other provider credential', async () => {
  const originalQuery = pool.query;
  const names = ['ANTHROPIC_API_KEY', 'CELERIS_API_KEY', 'ADMIN_EMAILS', 'APPLICATION_AGENT_MODE', 'APPLICATION_AGENT_MODE_AUTHORIZED'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fictional-haiku', CELERIS_API_KEY: 'fictional-celeris', ADMIN_EMAILS: 'admin@fixture.invalid', APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' });
  pool.query = (async (_sql: string, params: unknown[]) => ({ rows: [{ id: params[0], email: params[0] === 'admin' ? 'admin@fixture.invalid' : 'customer@fixture.invalid' }] })) as typeof originalQuery;
  try {
    const [admin, customer] = await Promise.all(['admin', 'customer'].map(owner => accountApplicationEnvironment(owner, { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' })));
    assert.equal(admin.APPLICATION_AI_MODEL, 'haiku');
    assert.equal(admin.CELERIS_API_KEY, '');
    assert.equal(admin.ANTHROPIC_API_KEY, 'fictional-haiku');
    assert.equal(admin.APPLICATION_AGENT_MODE, 'agent-only');
    assert.equal(admin.APPLICATION_AGENT_MODE_AUTHORIZED, 'true');
    assert.equal('HUMANIZER_MODE' in admin, false);
    assert.equal(customer.APPLICATION_AI_MODEL, 'celeris');
    assert.equal(customer.ANTHROPIC_API_KEY, '');
    assert.equal(customer.CELERIS_API_KEY, 'fictional-celeris');
    assert.equal(customer.APPLICATION_AGENT_MODE, 'protected');
    assert.equal(customer.APPLICATION_AGENT_MODE_AUTHORIZED, 'false');
    const defaultAdmin = await accountApplicationEnvironment('admin', {});
    assert.equal(defaultAdmin.APPLICATION_AGENT_MODE, 'protected');
    assert.equal(defaultAdmin.APPLICATION_AGENT_MODE_AUTHORIZED, 'false');
  } finally {
    pool.query = originalQuery;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});

test('model selection persists while retired form-review controls stay hidden', async () => {
  const originalQuery = pool.query;
  const stored: Record<string, string> = { APPLICATION_AI_MODEL: 'retired', APPLICATION_AI_FORM_REVIEW_MODE: 'retired', APPLICATION_AGENT_MODE: 'retired', APPLICATION_AGENT_MODE_AUTHORIZED: 'true',
    KEYWORDS: 'retail assistant', PLATFORMS_CHOSEN: '1' };
  const writes: unknown[][] = [];
  pool.query = (async (sql: string, params: unknown[]) => {
    assert.equal(params[0], 'owner-account');
    if (/INSERT INTO settings/.test(sql)) {
      writes.push(params); stored[String(params[1])] = String(params[2]); return { rows: [] };
    }
    assert.match(sql, /SELECT key, value FROM settings WHERE user_id = \$1/);
    return { rows: Object.entries(stored).map(([key, value]) => ({ key, value })) };
  }) as typeof originalQuery;
  try {
    assert.deepEqual(await loadUserSettings('owner-account'), { APPLICATION_AI_MODEL: 'celeris', APPLICATION_AGENT_MODE: 'protected', KEYWORDS: 'retail assistant', PLATFORMS_CHOSEN: '1' });
    const saved = await saveUserSettings('owner-account', { APPLICATION_AI_MODEL: 'haiku', APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true', KEYWORDS: 'sales assistant' });
    assert.deepEqual(writes, [['owner-account', 'APPLICATION_AI_MODEL', 'haiku'], ['owner-account', 'APPLICATION_AGENT_MODE', 'agent-only'], ['owner-account', 'KEYWORDS', 'sales assistant']]);
    assert.equal(saved.APPLICATION_AI_MODEL, 'haiku');
    assert.equal(saved.PLATFORMS_CHOSEN, '1');
    assert.equal((await runSettingsForUser('owner-account')).APPLICATION_AI_MODEL, 'haiku');
    assert.equal((await runSettingsForUser('owner-account')).APPLICATION_AGENT_MODE, 'agent-only');
    assert.equal(saved.APPLICATION_AGENT_MODE_AUTHORIZED, undefined);
    assert.equal(saved.APPLICATION_AI_FORM_REVIEW_MODE, undefined);
  } finally { pool.query = originalQuery; }
});
