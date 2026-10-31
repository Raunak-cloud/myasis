import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';
import { mayEditRunSetting } from './entitlements.js';

test('only admins can select either supported application provider', () => {
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'retired' }, true)?.status, 400);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'celeris' }, true), null);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'minimax' }, true), null);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'minimax' }, false)?.status, 403);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'unknown' }, true)?.status, 400);
  assert.equal(applicationModelSettingsError({ APPLICATION_AI_MODEL: 'retired' }, false)?.status, 403);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'admin', fineTune: true, advancedFilters: true }), true);
  assert.equal(mayEditRunSetting('APPLICATION_AI_MODEL', { tier: 'intensive', fineTune: true, advancedFilters: true }), false);
});

test('execution enforces admin-only MiniMax even with forged saved or run settings', () => {
  assert.equal(applicationModelForAccount('minimax', true), 'minimax');
  assert.equal(applicationModelForAccount('minimax', false), 'celeris');
  const customer = { PLATFORMS: 'seek', APPLICATION_AI_MODEL: 'minimax' };
  const admin = { ...customer };
  applyJobSourceAccess(customer, false);
  applyJobSourceAccess(admin, true);
  assert.equal(customer.APPLICATION_AI_MODEL, 'celeris');
  assert.equal(admin.APPLICATION_AI_MODEL, 'minimax');
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
