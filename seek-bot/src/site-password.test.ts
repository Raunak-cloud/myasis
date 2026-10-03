import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRules, sitePassword, type SiteCredential } from './site-auth.js';
import { PASSWORD_WORDS } from './password-words.js';

const secret = 'deployment-secret';
const email = 'raunak@example.com';
const readable = (rules: SiteCredential['rules'] = {}): SiteCredential => ({ format: 'readable-v1', rules });
const make = (site: string, rules?: SiteCredential['rules']) => sitePassword(`https://${site}/register`, email, secret, readable(rules))!;
const words = (password: string) => password.match(/[A-Z][a-z]+/g) ?? [];

test('accounts made before readable passwords keep their original password', () => {
  const legacy = sitePassword('https://careers.example.com/login', email, secret);
  assert.equal(sitePassword('https://careers.example.com/login', email, secret, null), legacy);
  assert.match(legacy!, /^My!.{14}9z$/);
});

test('a readable password is simple words, digits and a symbol', () => {
  const password = make('careers.example.com');
  assert.match(password, /^(?:[A-Z][a-z]+){2,4}\d{3}[^A-Za-z0-9]$/, password);
  for (const word of words(password)) assert.ok(PASSWORD_WORDS.includes(word.toLowerCase()), `${word} is a listed word`);
  assert.ok(password.length <= 24 && password.length >= 12);
});

test('the same site and person always get the same password, other sites another', () => {
  assert.equal(make('careers.example.com'), sitePassword('https://careers.example.com/login', email, secret, readable()));
  assert.notEqual(make('careers.example.com'), make('jobs.example.net'));
  assert.notEqual(make('careers.example.com'), sitePassword('https://careers.example.com/login', 'someone@example.com', secret, readable()));
});

test("Capgemini's 18-character limit is met", () => {
  for (const site of ['capgemini.com', 'a.example', 'b.example', 'c.example', 'd.example', 'e.example']) {
    const password = make(site, { max_length: 18 });
    assert.ok(password.length <= 18, `${password} fits 18`);
    assert.ok(words(password).length >= 2, `${password} is still readable`);
  }
});

test('the rules the agent reads are followed', () => {
  assert.match(make('nosymbols.example', { symbols: 'not_allowed' }), /^[A-Za-z0-9]+$/);
  assert.match(make('listed.example', { allowed_symbols: '#' }), /#$/);
  assert.ok(make('long.example', { min_length: 20, max_length: 32 }).length >= 20);
  const tight = make('tight.example', { max_length: 10 });
  assert.ok(tight.length <= 10 && /[A-Z]/.test(tight) && /[a-z]/.test(tight) && /\d/.test(tight), tight);
});

test('rules from the model are cleaned before use', () => {
  assert.deepEqual(normalizeRules({ max_length: '18', min_length: 30, symbols: 'sometimes', allowed_symbols: 'ab!! @' }), { max_length: 18, allowed_symbols: '!@' });
  assert.deepEqual(normalizeRules(null), {});
  assert.deepEqual(normalizeRules({ max_length: 3 }), {});
});
