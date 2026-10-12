import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brightDataBrowserEndpoint, employerBrowserProvider } from './employer-browser-config.js';

test('cloud browser requires account choice, server pilot and admin authorization', () => {
  assert.equal(employerBrowserProvider({}), 'local');
  const env = { EMPLOYER_BROWSER_PROVIDER: 'brightdata', BRIGHTDATA_ADMIN_ENABLED: 'true', BRIGHTDATA_BROWSER_ENABLED: 'true' };
  assert.equal(employerBrowserProvider(env), 'brightdata');
  assert.throws(() => employerBrowserProvider({ ...env, BRIGHTDATA_ADMIN_ENABLED: 'false' }));
  assert.throws(() => employerBrowserProvider({ ...env, BRIGHTDATA_BROWSER_ENABLED: 'false' }));
  assert.throws(() => employerBrowserProvider({ ...env, EMPLOYER_BROWSER_PROVIDER: 'arbitrary' }));
});

test('zone credentials go only to the fixed service; validation errors do not contain them', () => {
  const env = { BRIGHTDATA_BROWSER_USERNAME: 'brd-customer-test-zone-pilot', BRIGHTDATA_BROWSER_PASSWORD: 'fixture:p@ss/word' };
  const url = new URL(brightDataBrowserEndpoint(env));
  assert.equal(url.protocol, 'wss:'); assert.equal(url.hostname, 'brd.superproxy.io'); assert.equal(url.port, '9222');
  assert.equal(decodeURIComponent(url.password), env.BRIGHTDATA_BROWSER_PASSWORD);
  assert.throws(() => brightDataBrowserEndpoint({ ...env, BRIGHTDATA_BROWSER_USERNAME: 'user@evil.test' }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes(env.BRIGHTDATA_BROWSER_PASSWORD)); return true;
  });
});
