import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryQueries, searchCompetitors, searchLeads } from './core/search-discovery.js';
import { validateTasks, planTasks } from './core/planner.js';
import { reviewEvidence, coverageState } from './core/quality.js';
import { BlockedError } from './core/politeness.js';
import { EvidenceStore, evidence } from './core/store.js';
import type { Brief } from './core/types.js';
import { CostMeter } from './llm/celeris.js';
import { scorePosts } from './insights/social.js';
import { autocomplete } from './sources/autocomplete.js';
import { sourceById } from './sources/index.js';
import { runResearch } from './research.js';

const brief: Brief = { product: 'Traditional Nepalese clothing and Dhaka topi in Australia', niche: 'Nepali clothing', country: 'AU', audience: '', brand: '', language: 'en', competitors: [], websites: ['https://retailer.com.au/'], goals: [], sources: [], autoDiscover: false };

test('search leads use public result URLs; model prose, malformed data and unsafe citations are ignored', () => {
  const response = [{ url: 'https://retailer.com.au/product', title: 'Retailer' }, { url: 'https://retailer.com.au/other', title: 'Other product' }, { url: 'javascript:alert(1)', title: 'Bad' }, { url: 'https://user:pass@unsafe.com/', title: 'Bad' }, { url: 'https://127.0.0.1/', title: 'Bad' }, { url: 'https://invented.com/' }, { url: 'https://google.com/search?q=retailer', title: 'Search navigation' }];
  assert.deepEqual(searchLeads(response), ['https://retailer.com.au/']);
  for (const bad of [null, {}, { web: { results: {} } }]) assert.deepEqual(searchLeads(bad), []);
});

test('browser result wrappers resolve only public websites and malformed destinations are ignored', () => {
  const target = 'https://retailer.com.au/product';
  assert.deepEqual(searchLeads([{ url: `https://www.google.com/url?q=${encodeURIComponent(target)}`, title: 'Shop' }, { url: `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`, title: 'Shop' }, { url: 'https://www.bing.com/ck/a?u=a1bad', title: 'Bad' }, { url: 'https://www.google.com/url?q=https%3A%2F%2F127.0.0.1%2F', title: 'Bad' }, { url: 'https://instagram.com/shop/', title: 'Social profile' }]), ['https://retailer.com.au/']);
});

test('browser discovery queries use the product and actual market without guessing business identities', () => {
  assert.deepEqual(discoveryQueries({ ...brief, niche: '', product: 'Nepali clothing, including topi' }), ['Nepali clothing Australia shop', 'Nepali clothing Australia retailers']);
  assert.deepEqual(discoveryQueries({ ...brief, country: 'GB' }), ['Nepali clothing United Kingdom shop', 'Nepali clothing United Kingdom retailers']);
});

test('opaque Google links require visible public citations and unrelated result text is excluded', () => {
  const url = 'https://www.google.com/goto?url=opaque';
  assert.deepEqual(searchLeads([{ url, title: 'Boutique Nepal', displayedUrl: 'https://boutiquenepal.com.au › clothing' }, { url, title: 'Traditional definition', displayedUrl: 'https://dictionary.com/' }, { url, title: 'Nepali clothing' }, { url, title: 'Nepali clothing', displayedUrl: 'https://localhost/' }], 'Traditional Nepalese clothing'), ['https://boutiquenepal.com.au/']);
});

test('browser discovery records blocked and partial searches without retrying a blocked engine or inventing leads', async () => {
  const calls: string[] = [];
  const result = await searchCompetitors(brief, () => {}, Date.now() + 5000, async (engine, url) => {
    calls.push(engine);
    assert.equal(new URL(url).searchParams.get('q')?.includes('Australia'), true);
    if (engine === 'Google') throw new BlockedError('www.google.com', 'CAPTCHA');
    if (calls.length === 3) throw new Error('navigation timed out');
    return [{ url: 'https://retailer.com.au/', title: 'Nepali clothing shop', displayedUrl: '', snippet: '' }];
  });
  assert.deepEqual(calls, ['Google', 'Bing', 'Bing']);
  assert.deepEqual(result.websites, ['https://retailer.com.au/']);
  assert.deepEqual(result.searches.map((s) => s.status), ['blocked', 'ok', 'error']);
  assert.equal(result.searches[1].results?.length, 1);
  const expired = await searchCompetitors(brief, () => {}, Date.now() - 1, async () => { throw new Error('must not open a browser after deadline'); });
  assert.equal(expired.searches.length, 0);
  assert.equal(expired.websites.length, 0);
});

test('planner rejects invented advertiser domains, malformed model data and unsupported task reasons', () => {
  const tasks = validateTasks(brief, [null, { source: 'agent', query: 42 }, { source: 'google-ads', query: 'invented.com.au' }, { source: 'website', query: 'javascript:alert(1)' }, { source: 'google-ads', query: 'retailer.com.au', limit: Infinity, why: 'No competitors means huge unmet demand' }], [], 10);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].limit, sourceById('google-ads')!.defaultLimit);
  assert.doesNotMatch(tasks[0].why, /unmet demand|No competitors/i);
  assert.deepEqual(validateTasks(brief, {}, [], 10), []);
});

test('planning failures still preserve autocomplete and website audits before optional sources', async () => {
  const tasks = await planTasks(brief, new CostMeter(0), 2);
  assert.deepEqual(tasks.map((t) => t.source), ['autocomplete', 'website']);
});

test('wedding videos and model summaries cannot become verified clothing findings', () => {
  const items = [evidence({ source: 'youtube', kind: 'video', url: 'https://youtube.com/watch?v=wedding', text: 'Nepali wedding dance Australia' }), evidence({ source: 'agent', kind: 'page', url: 'https://retailer.com.au/', text: 'Sells 500 outfits a month' }), evidence({ source: 'agent', kind: 'page', url: 'https://retailer.com.au/product', text: 'Traditional Dhaka topi available in Australia', attributes: { literalQuoteVerified: 'true' } }), evidence({ source: 'tiktok', kind: 'video', url: 'https://tiktok.com/@seller/video/one', text: 'Dhaka topi wedding outfit' })];
  const result = reviewEvidence(items, brief);
  assert.equal(result.quality.unverified, 2);
  assert.deepEqual(result.evidence.map((i) => i.id), items.slice(2).map((i) => i.id));
});

test('autocomplete honours the total task cap across engines, without fetching irrelevant expansions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-autocomplete-'));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => { if (!String(input).endsWith('/robots.txt')) calls++; return new Response(JSON.stringify(['seed', Array.from({ length: 20 }, (_, i) => `dhaka topi ${i}`)]), { status: 200 }); };
  try {
    const items = await autocomplete.run({ source: 'autocomplete', query: 'dhaka topi', limit: 5, why: '' }, { brief, store: new EvidenceStore(dir), meter: new CostMeter(0), log: () => {} });
    assert.equal(items.length, 5);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
});

test('blocked collection persists coverage and renders a partial report without extending the budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-blocked-'));
  const source = sourceById('agent')!;
  const original = source.run;
  source.run = async () => { throw new BlockedError('retailer.com.au', 'CAPTCHA challenge'); };
  try {
    const result = await runResearch(brief, { runDir: dir, tasks: [{ source: 'agent', query: 'https://retailer.com.au/ :: quote products', limit: 5, why: '' }], log: () => {} });
    const saved = JSON.parse(readFileSync(join(dir, 'coverage.json'), 'utf8'));
    assert.equal(saved[0].ok, false);
    assert.equal(coverageState(saved[0]), 'Access unavailable');
    assert.equal(result.report.status, 'partial');
    assert.equal(result.report.sections.length, 0);
    assert.match(result.report.cost!, /estimated \$0\.0000/);
  } finally { source.run = original; rmSync(dir, { recursive: true, force: true }); }
});

test('social velocity is fixed to the collection snapshot; zero engagement remains in the baseline', () => {
  const posts = [0, 0, 10].map((likes, i) => evidence({ source: 'youtube', kind: 'video', url: `https://youtube.com/watch?v=${i}`, author: 'seller', publishedAt: '2026-01-01T00:00:00Z', collectedAt: '2026-01-03T00:00:00Z', metrics: { views: 100, likes } }));
  const scored = scorePosts(posts);
  assert.equal(scored[2].velocity, 5);
  assert.ok(Number.isNaN(scored[2].outlier));
});
