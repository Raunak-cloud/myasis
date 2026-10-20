import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';
import { mayEditRunSetting } from './entitlements.js';

test('legacy model settings accept only Celeris for admins and reject other values', () => {
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'retired' }, true)?.status, 400);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'celeris' }, true), null);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'unknown' }, true)?.status, 400);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'retired' }, false)?.status, 403);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'admin', fineTune: true, advancedFilters: true }), true);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'intensive', fineTune: true, advancedFilters: true }), false);
});

test('stale saved and process settings cannot enable another provider for any account', () => {
  for (const value of ['retired', 'celeris', undefined]) {
    for (const admin of [true, false]) assert.equal(applicationModelForAccount(value, admin), 'celeris');
  }
  const customer = { PLATFORMS: 'seek', APPLICATION_AI_MODEL: 'retired' };
  applyJobSourceAccess(customer, false);
  assert.equal(customer.APPLICATION_AI_MODEL, 'celeris');
  const admin = { PLATFORMS: 'seek', APPLICATION_AI_MODEL: 'retired' };
  applyJobSourceAccess(admin, true);
  assert.equal(admin.APPLICATION_AI_MODEL, 'celeris');
});
