import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';
test('customer execution pins Magnus despite old or forged selections', () => {
  for (const value of [undefined, 'celeris', 'minimax', 'retired']) {
    const admin = false;
    assert.equal(applicationModelForAccount(value, admin), 'celeris');
    const settings = {PLATFORMS:'seek', APPLICATION_AI_MODEL: String(value)};
    applyJobSourceAccess(settings,admin);
    assert.equal(settings.APPLICATION_AI_MODEL,'celeris');
  }
});
test('only admins can choose a supported whole-run provider', () => {
  assert.equal(applicationModelSettingsError({},false),null);
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'celeris'},true),null);
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'minimax'},true),null);
  for (const invalid of ['retired', null, {}, ['minimax']]) {
    assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:invalid},true)?.status,400);
    assert.equal(applicationModelForAccount(invalid,true),'celeris');
  }
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'minimax'},false)?.status,403);
  const settings = { PLATFORMS:'seek', APPLICATION_AI_MODEL:'minimax' };
  applyJobSourceAccess(settings,true);
  assert.equal(settings.APPLICATION_AI_MODEL,'minimax');
  applyJobSourceAccess(settings,false);
  assert.equal(settings.APPLICATION_AI_MODEL,'celeris','revoked admin access cannot retain MiniMax');
});
