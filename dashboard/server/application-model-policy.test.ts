import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';
import { mayEditRunSetting } from './entitlements.js';

test('only admins can choose supported application models', () => {
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'haiku' }, true), null);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'celeris' }, true), null);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'unknown' }, true)?.status, 400);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'haiku' }, false)?.status, 403);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'admin', fineTune: true, advancedFilters: true }), true);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'intensive', fineTune: true, advancedFilters: true }), false);
});

test('stale saved and process settings cannot enable Haiku for customers', () => {
  for (const value of ['haiku', 'celeris', undefined, 'retired']) {
    assert.equal(applicationModelForAccount(value, false), 'celeris');
  }
  const customer = { PLATFORMS: 'seek', APPLICATION_AI_MODEL: 'haiku' };
  applyJobSourceAccess(customer, false);
  assert.equal(customer.APPLICATION_AI_MODEL, 'celeris');
  const admin = { PLATFORMS: 'seek', APPLICATION_AI_MODEL: 'haiku' };
  applyJobSourceAccess(admin, true);
  assert.equal(admin.APPLICATION_AI_MODEL, 'haiku');
});
