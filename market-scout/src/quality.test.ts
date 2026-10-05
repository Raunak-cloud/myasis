import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { reviewEvidence, coverageState, sameWebsite } from './core/quality.js';
import { evidence, EvidenceStore } from './core/store.js';
import type { Brief } from './core/types.js';
import { canPublish, measuredSections, type Insights, type Report } from './report/synthesize.js';
import { renderHtml } from './report/render.js';
import { scoreAds, tierFor } from './insights/ads.js';
import { scorePosts } from './insights/social.js';
import { pickRetailPages } from './sources/website.js';
import { statusOf } from './ui/server.js';

let fixtureId = 0;
function fixture(partial: Omit<Parameters<typeof evidence>[0], 'url'> & { url?: string }) { return evidence({ url: `https://fixture.test/${++fixtureId}`, ...partial }); }

const brief: Brief = { product: 'Nepali clothing: Dhaka Topi, Daura Suruwal and sarees', niche: 'Nepali traditional clothing', brand: '', competitors: ['House of Nepal', 'Boutique Nepal'], websites: ['https://houseofnepal.com.au/', 'https://boutiquenepal.com.au/'], country: 'AU', language: 'en', audience: '', goals: [], sources: [] };

test('Nepali clothing research excludes the health and charity ads that polluted the audited run', () => {
  const items = [fixture({ source: 'meta-ads', kind: 'ad', author: 'Better Health Institute', text: "Parkinson's survivor — shop our shilajit", query: 'House of Nepal' }), fixture({ source: 'meta-ads', kind: 'ad', author: 'UNICEF Australia', text: 'Donate to children in Nepal', query: 'House of Nepal' }), fixture({ source: 'meta-ads', kind: 'ad', author: 'Boutique Nepal AU', text: 'Buy traditional outfits in Sydney' })];
  const result = reviewEvidence(items, brief);
  assert.deepEqual(result.evidence.map((i) => i.author), ['Boutique Nepal AU']);
  assert.equal(result.quality.excluded, 2);
  assert.equal(items.length, 3); // raw evidence is preserved
});

test('ad matching uses the advertiser or destination, not the query label', () => {
  const items = [fixture({ source: 'google-ads', kind: 'ad', author: 'Freak Street Pty Ltd', attributes: { landingUrl: 'https://houseofnepal.com.au/products/topi' } }), fixture({ source: 'meta-ads', kind: 'ad', author: 'Mystery', query: 'House of Nepal' })];
  const result = reviewEvidence(items, brief);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.quality.unverified, 1);
});

test('an unexpected redirect cannot turn a Google page into a retailer audit', () => {
  assert.equal(sameWebsite('https://www.boutiquenepal.com.au/product', 'https://boutiquenepal.com.au/'), true);
  assert.equal(sameWebsite('https://www.google.com/', 'https://boutiquenepal.com.au/'), false);
  const redirected = fixture({ source: 'website', kind: 'page', url: 'https://www.google.com/', query: 'https://boutiquenepal.com.au/', text: 'Google' });
  assert.equal(reviewEvidence([redirected], brief).quality.excluded, 1);
});

test('foreign purchase queries are rejected; generic queries are never relabelled Australian demand', () => {
  const items = [fixture({ source: 'autocomplete', kind: 'keyword', text: 'dhaka topi price in nepal' }), fixture({ source: 'autocomplete', kind: 'keyword', text: 'dhaka topi', query: 'Australia' }), fixture({ source: 'autocomplete', kind: 'keyword', text: 'nepali dress australia' })];
  const result = reviewEvidence(items, brief);
  assert.equal(result.quality.excluded, 1);
  assert.equal(result.quality.regionUnknown, 1);
  assert.equal(result.evidence[0].attributes.reviewRegion, 'unknown');
});

test('a Dhaka Topi song query cannot become a product-search recommendation', () => {
  const result = reviewEvidence([fixture({ source: 'autocomplete', kind: 'keyword', text: 'dhaka topi mailo chords' }), fixture({ source: 'autocomplete', kind: 'keyword', text: 'buy dhaka topi' })], brief);
  assert.equal(result.quality.excluded, 1);
  assert.deepEqual(result.evidence.map((i) => i.text), ['buy dhaka topi']);
});

test('social profile must be linked from the business website; captions are not customer research', () => {
  const items = [fixture({ source: 'website', kind: 'page', url: 'https://houseofnepal.com.au/', text: 'Our shop', attributes: { socialLinks: ['https://www.instagram.com/verified_nepal/'] } }), fixture({ source: 'instagram', kind: 'profile', url: 'https://www.instagram.com/houseofnepal/', author: 'houseofnepal' }), fixture({ source: 'instagram', kind: 'profile', url: 'https://www.instagram.com/verified_nepal/' }), fixture({ source: 'tiktok', kind: 'video', text: 'Dhaka topi: keep your culture alive', author: 'seller' }), fixture({ source: 'reddit', kind: 'comment', text: 'The sizing did not fit me' })];
  const result = reviewEvidence(items, brief);
  assert.equal(result.quality.unverified, 1);
  assert.equal(result.quality.customerItems, 1);
  assert.equal(result.evidence.find((i) => i.kind === 'video')?.attributes.reviewRole, 'creator');
});

test('partly checked, missing-citation, unchecked and forbidden claims cannot enter summary', () => {
  const finding = { finding: 'A listing offers a Dhaka Topi for AUD 15.', soWhat: 'Compare equivalent products before setting prices.', basis: 'observed' as const, evidence: ['website:1'], check: 'supported' };
  assert.equal(canPublish(finding), true);
  assert.equal(canPublish({ ...finding, check: 'partly: wrong price' }), false);
  assert.equal(canPublish({ ...finding, evidence: [] }), false);
  assert.equal(canPublish({ ...finding, check: 'not checked' }), false);
  assert.equal(canPublish({ ...finding, finding: 'No competitor has a dedicated Dhaka Topi page.' }), false);
  assert.equal(canPublish({ ...finding, finding: 'Wedding outfits are a high-volume segment.' }), false);
  assert.equal(canPublish({ ...finding, soWhat: 'This will convert buyers.' }), false);
});

test('unknown ad activity stays unknown and age labels do not imply profit', () => {
  const ad = scoreAds([fixture({ source: 'google-ads', kind: 'ad', metrics: { daysRunning: 40 } })])[0];
  assert.equal(ad.active, null);
  assert.equal(tierFor(40), '30–59 days observed');
  const legacy = fixture({ source: 'google-ads', kind: 'ad', author: 'Boutique Nepal', metrics: { daysRunning: 40, active: 1 } });
  assert.equal(scoreAds(reviewEvidence([legacy], brief).evidence)[0].active, null);
  assert.equal(legacy.metrics.active, 1); // preserve the old raw observation
});

test('social comparisons state whether baseline is a search sample or creator sample', () => {
  const a = fixture({ source: 'tiktok', kind: 'video', author: 'one', query: 'wedding', metrics: { views: 100, likes: 5 } });
  assert.equal(scorePosts([a])[0].baseline, 'search sample');
  const others = [2, 3].map((n) => fixture({ source: 'tiktok', kind: 'video', key: `post-${n}`, author: 'one', query: 'wedding', metrics: { views: 100, likes: 3 } }));
  assert.equal(scorePosts([a, ...others])[0].baseline, 'creator sample');
});

test('retailer crawl reserves relevant products and service policies', () => {
  const links = ['products/dhaka-topi', 'products/jewellery', 'policies/shipping-policy', 'policies/refund-policy'].map((path) => ({ text: '', href: `https://retailer.com/${path}` }));
  const pages = pickRetailPages(links, brief.product, 4);
  assert.ok(pages.some((p) => p.url.endsWith('dhaka-topi')));
  assert.ok(pages.some((p) => p.label === 'returns'));
  assert.ok(pages.some((p) => p.label === 'shipping'));
  assert.equal(pages.some((p) => p.url.endsWith('jewellery')), false);
});

test('no results and blocked collection have different user-facing states', () => {
  const task = { source: 'website' as const, query: 'https://x.test', why: '', limit: 5 };
  assert.equal(coverageState({ task, ok: true, count: 0, note: '', ms: 1 }), 'No results');
  assert.equal(coverageState({ task, ok: false, count: 0, note: 'blocked by login wall', ms: 1 }), 'Access unavailable');
});

test('failed rewrite cannot make an old report look successful', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-status-'));
  try {
    writeFileSync(join(dir, 'report.html'), 'old report');
    writeFileSync(join(dir, 'run.log'), '[run done]\n[run failed]');
    assert.equal(statusOf(dir), 'failed');
    writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ status: 'partial' }));
    assert.equal(statusOf(dir), 'partial');
  } finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(dir.includes('scout-status-')); rmSync(dir, { recursive: true, force: true }); }
});

test('public findings cannot inherit model claims about location, demand or creator baselines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-findings-'));
  try {
    const store = new EvidenceStore(dir);
    const keyword = fixture({ source: 'autocomplete', kind: 'keyword', text: 'dhaka topi' });
    const post = fixture({ source: 'tiktok', kind: 'video', author: 'creator', text: 'Wedding', metrics: { views: 100, likes: 5 } });
    store.add([keyword, post]);
    const insights: Insights = {
      keywords: { total: 1, questions: [], trends: [], topKeywords: [{ phrase: 'dhaka topi', intent: 'informational', engines: ['google'], bestRank: 1, words: 2, isQuestion: false, demand: 60, evidenceIds: [keyword.id] }], clusters: [{ name: 'High demand across Australian cities', intent: 'transactional', keywords: ['dhaka topi'], opportunity: 60, pageIdea: '', format: '' }] },
      ads: { total: 0, advertisers: [], winners: [], angles: [], patterns: { hook: [], awareness: [], offer: [], proof: [], emotion: [], cta: [] } },
      social: { posts: 1, hashtags: [], voc: [], topByPlatform: { tiktok: scorePosts([post]) } }, competitors: [],
    };
    const sections = measuredSections(insights, store);
    const text = JSON.stringify(sections);
    assert.ok(text.includes('search sample'));
    assert.ok(!text.includes('Australian cities'));
    assert.ok(!text.includes('creator sample'));
    const report: Report = { version: 2, status: 'ready', brief, generatedAt: new Date().toISOString(), headline: 'Findings', executiveSummary: [ { ...sections[0].findings[0], action: 'Test' } ], sections, recommendations: [], caveats: [], insights, coverage: [], cost: '' };
    const html = renderHtml(report, store);
    assert.ok(html.includes('Key findings'));
    assert.ok(html.includes('<details class="detail">'));
    assert.ok(!renderHtml({ ...report, version: 1 }, store).includes('Autocomplete returned'));
    store.add([fixture({ source: 'website', kind: 'page', text: '<script>bad</script>' })]);
    assert.ok(renderHtml({ ...report, headline: '<script>bad</script>' }, store).includes('&lt;script&gt;'));
  } finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(dir.includes('scout-findings-')); rmSync(dir, { recursive: true, force: true }); }
});
