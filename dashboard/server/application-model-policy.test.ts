import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationModelCredentials, applicationModelForAccount, applicationModelSettingsError } from './application-model-policy.js';
import { applyJobSourceAccess } from './job-sources.js';

test('authorized models receive only their own credential, including every OpenRouter model',()=>{
 const server={CELERIS_API_KEY:'fictional-celeris',OPENROUTER_API_KEY:'fictional-openrouter'};
 for(const model of ['minimax'] as const){
  assert.deepEqual(applicationModelCredentials(model,server),{CELERIS_API_KEY:'',OPENROUTER_API_KEY:server.OPENROUTER_API_KEY});
  assert.throws(()=>applicationModelCredentials(model,{CELERIS_API_KEY:server.CELERIS_API_KEY}),/OPENROUTER_API_KEY/);
 }
 assert.deepEqual(applicationModelCredentials('celeris',server),{CELERIS_API_KEY:server.CELERIS_API_KEY,OPENROUTER_API_KEY:''});
 assert.throws(()=>applicationModelCredentials('celeris',{OPENROUTER_API_KEY:server.OPENROUTER_API_KEY}),/CELERIS_API_KEY/);
});
test('customer execution pins Magnus despite old or forged selections', () => {
  for (const value of [undefined, 'celeris', 'minimax', 'deepseek', 'retired']) {
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
  assert.equal(applicationModelSettingsError({APPLICATION_AI_MODEL:'deepseek'},false)?.status,403);
  for (const invalid of ['deepseek', 'glm', 'retired', null, {}, ['minimax']]) {
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
