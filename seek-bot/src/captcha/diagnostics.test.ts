import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captchaDiagnosticSecrets, safeCaptchaDiagnostic } from './diagnostics.js';

test('provider and protocol explanations survive while secrets, URLs and arbitrary payloads do not', () => {
  const secrets = captchaDiagnosticSecrets({ FIXTURE_BROWSER_PASSWORD: 'private/p@ssword', CELERIS_API_KEY: 'private-api-key', HOME: '/safe/home' });
  const error = Object.assign(new Error('Protocol error (Captcha.solve): solver unavailable; wss://user:private%2Fp%40ssword@browser.fixture.invalid:9222/?token=abc email me@example.test api_key=other-secret Bearer bearer-secret'), { code: -32000, stack: 'private stack' });
  const result = safeCaptchaDiagnostic(error, secrets);
  assert.equal(result.code, -32000);
  assert.match(String(result.message), /Protocol error \(Captcha.solve\): solver unavailable/);
  const json = JSON.stringify(result);
  for (const forbidden of ['private', 'me@example', 'other-secret', 'bearer-secret', 'superproxy', 'stack']) assert.ok(!json.includes(forbidden), forbidden);
  assert.deepEqual(safeCaptchaDiagnostic({ status: 'solve_failed', error: { message: 'unsupported challenge', code: 42, cookies: 'private cookie' }, resume: 'private document' }), { status: 'solve_failed', error: { message: 'unsupported challenge', code: 42 } });
  const event = safeCaptchaDiagnostic({ type: 'hcaptcha', message: '{"token":"unknown-token", "password":"unknown-password"}', solution: 'private response token' });
  assert.equal(event.type, 'hcaptcha');
  assert.ok(!JSON.stringify(event).includes('unknown-token'));
  assert.ok(!JSON.stringify(event).includes('unknown-password'));
  assert.ok(!JSON.stringify(event).includes('solution'));
});
