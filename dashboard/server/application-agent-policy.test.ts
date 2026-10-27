import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { applicationAgentModeForAccount, applicationAgentSettingsError, applicationScreenshotsForAccount } from './application-agent-policy.js';
import { applyJobSourceAccess, jobSourceSettingsError } from './job-sources.js';
import { mayEditRunSetting } from './entitlements.js';
import { USER_SETTABLE_SETTINGS_KEYS } from './settings.js';
import { getPool } from './db/index.js';
import { startRun } from './start-run.js';

after(async () => { await getPool().end(); });

test('screenshots each turn are opt-in and admin-only at save and execution time', () => {
  const key = 'APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN';
  for (const value of ['true', 'false']) {
    assert.equal(jobSourceSettingsError({ [key]: value }, true), null);
    assert.equal(jobSourceSettingsError({ [key]: value }, false)?.status, 403);
  }
  assert.equal(jobSourceSettingsError({ [key]: 'everywhere' }, true)?.status, 400);
  assert.equal(mayEditRunSetting(key, { tier: 'standard', fineTune: true, advancedFilters: true }), false);
  assert.equal(mayEditRunSetting(key, { tier: 'admin', fineTune: true, advancedFilters: true }), true);
  assert.equal(applicationScreenshotsForAccount(undefined, true), 'false');
  assert.equal(applicationScreenshotsForAccount('true', true), 'true');
  assert.equal(applicationScreenshotsForAccount('true', false), 'false');
  const settings: Record<string, string> = { [key]: 'true' };
  applyJobSourceAccess(settings, false);
  assert.equal(settings[key], 'false');
});

test('legacy settings accept only Agent-only and no caller may supply authorization', () => {
  for (const mode of ['agent-only']) {
    assert.equal(applicationAgentSettingsError({ APPLICATION_AGENT_MODE: mode }, true), null);
    assert.equal(applicationAgentSettingsError({ APPLICATION_AGENT_MODE: mode }, false)?.status, 403);
  }
  assert.equal(applicationAgentSettingsError({ APPLICATION_AGENT_MODE: 'other' }, true)?.status, 400);
  assert.equal(applicationAgentSettingsError({ APPLICATION_AGENT_MODE: 'protected' }, true)?.status, 400);
  for (const admin of [true, false]) assert.equal(applicationAgentSettingsError({ APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }, admin)?.status, 403);
  assert.equal(mayEditRunSetting('APPLICATION_AGENT_MODE', { tier: 'admin', fineTune: true, advancedFilters: true }), true);
  assert.equal(mayEditRunSetting('APPLICATION_AGENT_MODE', { tier: 'intensive', fineTune: true, advancedFilters: true }), false);
  assert.equal((USER_SETTABLE_SETTINGS_KEYS as readonly string[]).includes('APPLICATION_AGENT_MODE_AUTHORIZED'), false);
});

test('all accounts use Agent-only despite stale saved modes and strips forged authorization', () => {
  for (const value of ['agent-only', 'protected', undefined, 'retired']) assert.equal(applicationAgentModeForAccount(value, false), 'agent-only');
  assert.equal(applicationAgentModeForAccount('agent-only', true), 'agent-only');
  const customer = { PLATFORMS: 'seek', APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' };
  applyJobSourceAccess(customer, false);
  assert.equal(customer.APPLICATION_AGENT_MODE, 'agent-only');
  assert.equal('APPLICATION_AGENT_MODE_AUTHORIZED' in customer, false);
  const admin = { PLATFORMS: 'seek', APPLICATION_AGENT_MODE: 'agent-only' };
  applyJobSourceAccess(admin, true);
  assert.equal(admin.APPLICATION_AGENT_MODE, 'agent-only');
  assert.equal(jobSourceSettingsError({ APPLICATION_AGENT_MODE: 'agent-only' }, false)?.status, 403);
});

test('every run trigger rejects customer mode overrides before database or browser actions', async () => {
  const pool = getPool();
  const original = pool.query;
  pool.query = (async () => { throw new Error('Unauthorized mode reached database'); }) as typeof original;
  try {
    for (const trigger of ['manual', 'auto', 'admin', 'onboarding'] as const) for (const mode of ['search', 'live'] as const) {
      for (const clientOverrides of [{ APPLICATION_AGENT_MODE: 'agent-only' }, { APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }, { APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'true' }]) {
        const result = await startRun({ userId: 'agent-mode-customer', email: 'customer@fixture.invalid', mode, trigger, clientOverrides });
        assert.ok(!result.ok && result.status === 403, `${trigger}/${mode}`);
      }
    }
  } finally { pool.query = original; }
});
