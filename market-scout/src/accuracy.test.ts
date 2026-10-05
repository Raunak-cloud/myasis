import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidence, EvidenceStore } from './core/store.js';
import { reviewEvidence } from './core/quality.js';
import type { Brief } from './core/types.js';
import { retailListings, seoIssues } from './insights/competitors.js';
import { buildMarketingPlan } from './report/planning.js';
import { publicInsights, synthesize, type Insights } from './report/synthesize.js';
import { renderHtml, renderMarkdown } from './report/render.js';
import { CostMeter } from './llm/celeris.js';

const brief: Brief = { product: 'Wedding outfits', niche: 'clothing', brand: '', competitors: [], websites: ['https://shop.com.au/'], country: 'AU', audience: '', language: 'en', goals: [], sources: [], ownWebsite: 'https://shop.com.au/' };
const empty: Insights = { keywords: { total: 0, questions: [], topKeywords: [], clusters: [], trends: [] }, ads: { total: 0, advertisers: [], winners: [], angles: [], patterns: { hook: [], awareness: [], offer: [], proof: [], emotion: [], cta: [] } }, social: { posts: 0, topByPlatform: {}, hashtags: [], voc: [] }, competitors: [] };
const page = () => evidence({ source: 'website', kind: 'page', url: 'https://shop.com.au/products/outfit', author: 'shop.com.au', text: 'Wedding outfit with sizing and delivery.', title: 'Wedding outfit', attributes: { pageType: 'product', metaDescription: 'Wedding outfits delivered in Australia', canonical: 'https://shop.com.au/products/outfit' }, metrics: { h1Count: 1, wordCount: 10 } });

test('refresh drops old metrics and attributes while retaining the historical snapshot on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-accuracy-'));
  try {
    const store = new EvidenceStore(dir);
    const old = evidence({ source: 'youtube', kind: 'video', url: 'https://youtube.com/watch?v=one', metrics: { views: 100, likes: 5 }, attributes: { oldFact: 'outdated' }, collectedAt: '2026-01-01T00:00:00.000Z' });
    store.add([old]);
    store.add([evidence({ source: 'youtube', kind: 'video', url: old.url, metrics: { views: 200 } })]);
    assert.deepEqual(store.get(old.id)?.metrics, { views: 200 });
    assert.deepEqual(store.get(old.id)?.attributes, {});
    assert.equal(readFileSync(join(dir, 'evidence.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(new EvidenceStore(dir).get(old.id)?.metrics, { views: 200 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid citations, future dates and impossible counts cannot enter analysis; negative Reddit scores can', () => {
  const valid = evidence({ source: 'reddit', kind: 'comment', url: 'https://reddit.com/r/clothing/comments/one', text: 'I need wedding outfit sizing', collectedAt: '2026-01-01T00:00:00Z' });
  const cases = [{ ...valid, id: 'bad-url', url: 'javascript:alert(1)' }, { ...valid, id: 'future', collectedAt: '2030-01-01T00:00:00Z' }, { ...valid, id: 'negative', metrics: { views: -1 } }, { ...valid, id: 'nan', metrics: { views: NaN } }, { ...valid, id: 'date', collectedAt: '' }, { ...valid, id: 'allowed', metrics: { score: -2 } }];
  const result = reviewEvidence(cases, brief, Date.parse('2026-01-02T00:00:00Z'));
  assert.deepEqual(result.evidence.map((i) => i.id), ['allowed']);
  assert.equal(result.quality.unverified, 5);
});

test('product prices require numeric offers and safe same-site links; aggregate low prices remain labelled', () => {
  const p = page();
  p.attributes.products = JSON.stringify([
    { name: 'Bad price', price: 'call us', currency: 'AUD' }, { name: 'Bad currency', price: '15', currency: '$' }, { name: 'Bad link', price: '15', currency: 'AUD', url: 'javascript:alert(1)' }, { name: 'Other shop', price: '15', currency: 'AUD', url: 'https://different.com/' }, { name: 'Broken link', price: '15', url: 'http://[' },
    { name: 'Wedding outfit', price: '129.50', currency: 'aud', availability: 'https://schema.org/InStock', url: '/products/outfit', priceBasis: 'lowest listed price' },
  ]);
  const listings = retailListings(p);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].currency, 'AUD');
  assert.equal(listings[0].priceBasis, 'lowest listed price');
  assert.equal(listings[0].url, p.url);
});

test('SEO audit reports measured checks without invented truncation, word-count or multiple-H1 penalties', () => {
  const p = page();
  p.metrics = { wordCount: 10, titleLength: 90, h1Count: 2, imagesWithoutAlt: 1 };
  assert.deepEqual(seoIssues(p), ['1 images without alt text; review informative images']);
  p.attributes.robotsMeta = 'noindex';
  assert.ok(seoIssues(p).some((s) => s.includes('intentional')));
});

test('own-site plan excludes competitor fixes and preserves source dates in regenerated reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-accuracy-'));
  try {
    const store = new EvidenceStore(dir);
    const p = page(); p.title = ''; p.collectedAt = '2026-01-01T00:00:00Z';
    const other = { ...p, id: 'other', url: 'https://competitor.com/', author: 'competitor.com' };
    const k = evidence({ source: 'autocomplete', kind: 'keyword', url: 'https://google.com/complete/search?q=outfit', text: 'buy wedding outfit australia', attributes: { engine: 'google' }, collectedAt: p.collectedAt, metrics: { rank: 1 } });
    store.add([p, other, k]);
    const plan = buildMarketingPlan(brief, [p, other, k]);
    assert.equal(plan.auditActions.length, 1);
    assert.equal(plan.auditActions[0].url, p.url);
    assert.equal(plan.auditActions[0].owner, 'Your site');
    assert.equal(plan.evidenceWindow?.last, p.collectedAt);
    const report = { ...await synthesize(brief, empty, [], store, new CostMeter(1)), cost: '', version: 3 };
    const html = renderHtml(report, store), md = renderMarkdown(report, store);
    assert.ok(html.includes('Your four-week action plan'));
    assert.ok(html.includes('Not measured:'));
    assert.ok(html.includes(p.collectedAt));
    assert.ok(md.includes('Collected: 2026-01-01'));
    assert.ok(!JSON.stringify(report.recommendations).includes('"ice"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public details drop model-generated prices and phrases even when an existing evidence ID is attached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-accuracy-'));
  try {
    const store = new EvidenceStore(dir), p = page(); store.add([p]);
    const contaminated: Insights = { ...empty, keywords: { ...empty.keywords, topKeywords: [{ phrase: 'invented high-volume phrase', intent: 'transactional', engines: ['google'], bestRank: 1, words: 3, isQuestion: false, demand: 100, evidenceIds: [p.id] }] }, competitors: [{ host: p.author, pages: [{ type: 'product', title: p.title, url: p.url, evidenceId: p.id }], positioning: { valueProposition: 'Invented winner', audience: '', category: '', differentiators: [], pricingModel: '', priceTiers: [], freeTrial: '', offers: [], guarantees: [], proof: [], primaryCta: '' }, retail: [{ name: 'Made up', price: '999', currency: 'AUD', availability: '', url: p.url, evidenceId: p.id }], seoIssues: [], pixels: [], stack: [], contentSections: [], contentTopics: 0 }] };
    const clean = publicInsights(contaminated, store, brief);
    assert.equal(clean.keywords.topKeywords.length, 0);
    assert.equal(clean.competitors[0].retail?.length, 0);
    assert.equal(clean.competitors[0].positioning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
