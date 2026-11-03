import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';
test('customer execution pins MiniMax despite old, forged or admin comparison settings', () => {
  for (const admin of [true, false]) for (const value of [undefined, 'celeris', 'minimax', 'retired']) {
    assert.equal(applicationModelForAccount(value, admin), 'minimax');
    const settings = {PLATFORMS:'seek', APPLICATION_AI_MODEL: String(value)};
    applyJobSourceAccess(settings,admin);
    assert.equal(settings.APPLICATION_AI_MODEL,'minimax');
  }
});
test('settings cannot restore the old whole-run provider switch', () => {
  assert.equal(applicationModelSettingsError({},false),null);
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'minimax'},true),null);
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'celeris'},true)?.status,400);
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'minimax'},false)?.status,403);
});
