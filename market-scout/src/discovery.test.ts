import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateUrl, verifiedCandidate, relatedWebsites } from './core/discovery.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('discovery can reuse related public-site leads without importing another market or category', () => {
  const root = mkdtempSync(join(tmpdir(), 'scout-discovery-'));
  try {
    const write = (name: string, product: string, country: string, website: string) => {
      const dir = join(root, name); mkdirSync(dir);
      writeFileSync(join(dir, 'brief.json'), JSON.stringify({ product, niche: '', country, websites: [website] }));
    };
    write('nepali', 'Traditional Nepali clothing', 'AU', 'https://boutiquenepal.com.au/');
    write('foreign', 'Traditional Nepalese clothing', 'CA', 'https://another.example.com/');
    write('other', 'Gym activewear for women', 'AU', 'https://gym.example.com/');
    const brief = { product: 'Traditional Nepalese clothing', niche: '', country: 'AU' } as Brief;
    assert.deepEqual(relatedWebsites(brief, root), ['https://boutiquenepal.com.au/']);
  } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('scout-discovery-')); rmSync(root, { recursive: true, force: true }); }
});
