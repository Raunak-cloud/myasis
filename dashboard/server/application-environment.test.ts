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
    GMAIL_MCP_TOKEN: 'foreign-mailbox-capability', GMAIL_MCP_URL: 'http://foreign.invalid', GMAIL_MCP_ACCOUNT: 'foreign@fixture.invalid',
    OPENROUTER_API_KEY: 'foreign-credential', OPENROUTER_BASE_URL: 'http://foreign.invalid',
    RETIRED_BROWSER_PASSWORD: 'fixture-browser-password' };
  const before = { ...input };
  assert.deepEqual(applicationRunEnvironment(input), { PATH: 'fixture-path', DATA_DIR: '/owner/files',
    CELERIS_API_KEY: 'fixture-key', SITE_AUTH_SECRET: 'fixture-session' });
  assert.deepEqual(input, before);
});

test('owner authorization selects one whole-run provider and server-owned credential', async () => {
  const originalQuery = pool.query;
  const names = ['CELERIS_API_KEY','OPENROUTER_API_KEY','ADMIN_EMAILS'] as const;
  const prior = Object.fromEntries(names.map(name => [name,process.env[name]]));
  Object.assign(process.env,{CELERIS_API_KEY:'server-review-key',OPENROUTER_API_KEY:'server-apply-key',ADMIN_EMAILS:'admin@fixture.invalid'});
  pool.query = (async(sql:string,params:unknown[]) => ({rows: sql.includes('FROM run_starts')
    ? params[0]==='authorized'?[{email:'admin@fixture.invalid'}]:[]
    : [{id:params[0],email:params[0]==='admin'?'admin@fixture.invalid':'customer@fixture.invalid'}]})) as typeof originalQuery;
  try {
    for (const owner of ['admin','customer']) for (const selected of ['celeris','minimax','retired']) {
      const settings={APPLICATION_AI_MODEL:selected,CELERIS_API_KEY:'forged-review',OPENROUTER_API_KEY:'forged-apply'};
      const env=await accountApplicationEnvironment(owner,settings);
      const minimax=owner==='admin' && selected==='minimax';
      assert.equal(env.APPLICATION_AI_MODEL,minimax?'minimax':'celeris');
      assert.equal(env.CELERIS_API_KEY,minimax?'':'server-review-key');
      assert.equal(env.OPENROUTER_API_KEY,minimax?'server-apply-key':'');
      assert.equal(env.DATA_DIR,userDir(owner));
      assert.equal(env.APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN,minimax?'false':'true');
      assert.equal(env.APPLICATION_AGENT_MODE,'agent-only');
      assert.equal(settings.APPLICATION_AI_MODEL,selected,'no saved preference mutation');
    }
    await assert.rejects(accountApplicationEnvironment('customer',{ADMIN_APPLICATION_MODEL:'minimax'},'authorized'),/no valid administrator/);
    await assert.rejects(accountApplicationEnvironment('customer',{ADMIN_APPLICATION_MODEL:'minimax'},'unverified'),/no valid administrator/);
    assert.equal((await accountApplicationEnvironment('customer',{ADMIN_APPLICATION_MODEL:'celeris'},'authorized')).APPLICATION_AI_MODEL,'celeris');
    process.env.CELERIS_API_KEY='';
    await assert.rejects(accountApplicationEnvironment('customer',{}),/Magnus job review is not configured/);
    assert.equal((await accountApplicationEnvironment('admin',{APPLICATION_AI_MODEL:'minimax'})).APPLICATION_AI_MODEL,'minimax','MiniMax does not require a Celeris key');
    process.env.CELERIS_API_KEY='server-review-key';process.env.OPENROUTER_API_KEY='';
    await assert.rejects(accountApplicationEnvironment('admin',{APPLICATION_AI_MODEL:'minimax'}),/OPENROUTER_API_KEY/);
    assert.equal((await accountApplicationEnvironment('customer',{})).APPLICATION_AI_MODEL,'celeris','Magnus must not require an unused OpenRouter key');
    await assert.rejects(accountApplicationEnvironment('../customer',{}),/account is not available/);
    pool.query=(async()=>({rows:[]})) as unknown as typeof originalQuery;
    await assert.rejects(accountApplicationEnvironment('customer',{}),/account is not available/);
  } finally {
    pool.query=originalQuery;
    for(const name of names) if(prior[name]===undefined) delete process.env[name];else process.env[name]=prior[name];
  }
});

test('settings preserve supported selections while retired form-review controls stay hidden', async () => {
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
    assert.deepEqual(await loadUserSettings('owner-account'), { APPLICATION_AI_MODEL: 'celeris', APPLICATION_AGENT_MODE: 'agent-only', KEYWORDS: 'retail assistant', PLATFORMS_CHOSEN: '1' });
    const saved = await saveUserSettings('owner-account', { APPLICATION_AI_MODEL: 'celeris', APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true', KEYWORDS: 'sales assistant' });
    assert.deepEqual(writes, [['owner-account', 'APPLICATION_AI_MODEL', 'celeris'], ['owner-account', 'APPLICATION_AGENT_MODE', 'agent-only'], ['owner-account', 'KEYWORDS', 'sales assistant']]);
    assert.equal(saved.APPLICATION_AI_MODEL, 'celeris');
    assert.equal(saved.PLATFORMS_CHOSEN, '1');
    assert.equal((await runSettingsForUser('owner-account')).APPLICATION_AI_MODEL, 'celeris');
    assert.equal((await runSettingsForUser('owner-account')).APPLICATION_AGENT_MODE, 'agent-only');
    assert.equal(saved.APPLICATION_AGENT_MODE_AUTHORIZED, undefined);
    assert.equal(saved.APPLICATION_AI_FORM_REVIEW_MODE, undefined);
    const resolved = await saveUserSettings('owner-account', { APPLICATION_AI_MODEL: 'minimax' });
    assert.equal(resolved.APPLICATION_AI_MODEL, 'minimax', 'storage preserves the choice; execution rechecks owner authorization');
    assert.equal((await runSettingsForUser('owner-account')).APPLICATION_AI_MODEL, 'minimax');
  } finally { pool.query = originalQuery; }
});
