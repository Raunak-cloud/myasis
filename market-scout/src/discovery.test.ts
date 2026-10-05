import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateUrl, verifiedCandidate, shortSeed } from './core/discovery.js';
import { evidence } from './core/store.js';
import { baselinePlan } from './core/planner.js';
import type { Brief } from './core/types.js';

const page = evidence({ source: 'website', kind: 'page', url: 'https://boutiquenepal.com.au/', title: 'Boutique Nepal', text: 'Boutique Nepal sells Nepali traditional clothing. Pickup available in Sydney, Australia.' });
const check = { relevant: true, name: 'Boutique Nepal', productQuote: 'sells Nepali traditional clothing', marketQuote: 'Pickup available in Sydney, Australia.' };

test('automatic competitors need actual product evidence and get their website from the visited page', () => {
  const result = verifiedCandidate(page, check, 'AU');
  assert.ok(result);
  assert.equal(result.website, 'https://boutiquenepal.com.au/');
  assert.equal(result.region, 'target');
  assert.equal(verifiedCandidate(page, { ...check, marketQuote: '' }, 'AU')?.region, 'target');
  const brief: Brief = { product: 'Nepali clothing', niche: 'Nepali traditional clothing', brand: '', audience: 'Suggested diaspora buyers', country: 'AU', language: 'en', competitors: [result.name], websites: [result.website], goals: [], sources: ['website', 'autocomplete'] };
  assert.ok(baselinePlan(brief).some((t) => t.source === 'website' && t.query === result.website));
});

test('invented brand names, fabricated quotes and unrelated sellers cannot become competitors', () => {
  assert.equal(verifiedCandidate(page, { ...check, name: 'Imaginary Clothing' }, 'AU'), undefined);
  assert.equal(verifiedCandidate(page, { ...check, productQuote: 'Authentic Daura Suruwal delivered nationwide' }, 'AU'), undefined);
  assert.equal(verifiedCandidate(page, { ...check, relevant: false }, 'AU'), undefined);
  assert.equal(verifiedCandidate(page, { ...check, marketQuote: 'We serve Melbourne' }, 'AU')?.region, 'unknown');
});

test('automatic website candidates are public HTTPS roots, without credentials or local addresses', () => {
  assert.equal(candidateUrl('https://shop.example.com/products/topi?utm=test'), 'https://shop.example.com/');
  for (const url of ['http://shop.example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://host.internal/', 'https://user:secret@shop.example.com/', 'https://shop.example.com:5190/']) assert.equal(candidateUrl(url), undefined);
});

test('suggested search seeds remove punctuation-only words and cap category length', () => {
  assert.equal(shortSeed('Traditional Nepalese clothing in Australia, including Dhaka topi'), 'nepali clothing');
  assert.equal(shortSeed('Nepali clothing ,'), 'nepali clothing');
  assert.equal(shortSeed('nepali clothing including'), 'nepali clothing');
});

test('literal product quotes can establish the target market despite a failed market-quote extraction', () => {
  const local = { ...page, text: 'Boutique Nepal sells Nepali clothing in Australia.' };
  const result = verifiedCandidate(local, { ...check, productQuote: 'sells Nepali clothing in Australia.', marketQuote: 'Made up shipping statement' }, 'AU');
  assert.equal(result?.region, 'target');
  assert.equal(result?.marketQuote, 'sells Nepali clothing in Australia.');
  assert.equal(verifiedCandidate(page, { ...check, relevant: 'true' as unknown as boolean }, 'AU'), undefined);
});
