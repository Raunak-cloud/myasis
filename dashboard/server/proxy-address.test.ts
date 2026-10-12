import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProxy } from './proxy-address.js';

test('malformed proxy credentials return a validation error instead of throwing', () => {
  for (const credentials of ['user:bad%password', 'bad%user:password', 'user:%E0%A4%A']) {
    assert.equal(parseProxy(`socks5://${credentials}@proxy.example.com:1080`),
      'The proxy username or password contains invalid URL encoding.');
  }
});

test('encoded credentials are decoded once and provider-list passwords remain literal', () => {
  assert.deepEqual(parseProxy('socks5://user%40name:p%25ss%3Aword@proxy.example.com:1080'), {
    host: 'proxy.example.com', port: 1080, username: 'user@name', password: 'p%ss:word',
  });
  assert.deepEqual(parseProxy('proxy.example.com:1080:user:bad%password'), {
    host: 'proxy.example.com', port: 1080, username: 'user', password: 'bad%password',
  });
});
