import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRecords, parseLooseJson, pickString, toIsoDate } from './core/harvest.js';
import { parseRobots } from './core/politeness.js';
import { evidence, parseCount } from './core/store.js';
import { conceptKey, scoreAd, scoreAds, tierFor } from './insights/ads.js';
import { seoIssues } from './insights/competitors.js';
import { classifyIntent, mergeKeywords } from './insights/keywords.js';
import { engagementRate, scorePosts } from './insights/social.js';
import { strictSchema } from './llm/celeris.js';
import { chunkText } from './llm/extract.js';
import { expansions } from './sources/autocomplete.js';
import { detectStack, inventory, pickKeyPages } from './sources/website.js';

test('robots: longest match wins, Allow wins ties, wildcards and $ anchor', () => {
  const rules = parseRobots(
    ['User-agent: *', 'Disallow: /private', 'Allow: /private/public', 'Disallow: /*.pdf$', 'Crawl-delay: 4', 'Sitemap: https://x.com/sitemap.xml'].join('\n'),
    'MarketScout',
  );
  assert.equal(rules.isAllowed('/private/a'), false);
  assert.equal(rules.isAllowed('/private/public/a'), true);
  assert.equal(rules.isAllowed('/files/a.pdf'), false);
  assert.equal(rules.isAllowed('/files/a.pdf?x=1'), true);
  assert.equal(rules.isAllowed('/'), true);
  assert.equal(rules.crawlDelayMs, 4000);
  assert.deepEqual(rules.sitemaps, ['https://x.com/sitemap.xml']);
});

test('robots: a group naming our agent replaces the * group', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: marketscout\nDisallow: /admin', 'MarketScout');
  assert.equal(rules.isAllowed('/blog'), true);
  assert.equal(rules.isAllowed('/admin/x'), false);
});

test('robots: empty Disallow allows everything', () => {
  assert.equal(parseRobots('User-agent: *\nDisallow:', 'x').isAllowed('/anything'), true);
});

test('harvest finds records by shape regardless of nesting', () => {
  const doc = { data: { a: { edges: [{ node: { collated_results: [{ ad_archive_id: '1', snapshot: {} }, { ad_archive_id: '2', snapshot: {} }] } }] } } };
  const found = findRecords(doc, (node) => typeof node.ad_archive_id === 'string');
  assert.deepEqual(found.map((n) => n.ad_archive_id), ['1', '2']);
});

test('loose JSON strips hijacking prefixes and reads line streams', () => {
  assert.deepEqual(parseLooseJson('for (;;);{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseLooseJson('{"a":1}\n{"b":2}\nnot json'), [{ a: 1 }, { b: 2 }]);
  assert.equal(pickString({ a: { b: [{ c: 'x' }] } }, 'a.missing', 'a.b.0.c'), 'x');
  assert.equal(toIsoDate(1_700_000_000), new Date(1_700_000_000_000).toISOString());
});

test('counts as platforms display them', () => {
  assert.equal(parseCount('1.2K'), 1200);
  assert.equal(parseCount('3,400 likes'), 3400);
  assert.equal(parseCount('2.5M'), 2_500_000);
  assert.ok(Number.isNaN(parseCount('none')));
});

test('evidence drops non-finite metrics and has a stable id', () => {
  const a = evidence({ source: 'reddit', kind: 'post', url: 'https://r/1', metrics: { score: 5, views: Number.NaN } });
  const b = evidence({ source: 'reddit', kind: 'post', url: 'https://r/1' });
  assert.deepEqual(a.metrics, { score: 5 });
  assert.equal(a.id, b.id);
});

test('strict schema makes every field required and closed', () => {
  const schema = strictSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } });
  assert.deepEqual(schema.required, ['a']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual((schema.properties as Record<string, Record<string, unknown>>).a.required, ['b']);
});

test('chunks split at headings and never exceed the size', () => {
  const text = Array.from({ length: 50 }, (_, i) => `# H${i}\n${'word '.repeat(100)}`).join('\n');
  const chunks = chunkText(text, 2_000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2_000));
  assert.equal(chunks.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('autocomplete expansions cover questions, comparisons and a-z when wide', () => {
  const narrow = expansions('Protein Powder', false);
  assert.ok(narrow.includes('how protein powder'));
  assert.ok(narrow.includes('protein powder vs'));
  assert.ok(!narrow.includes('protein powder a'));
  assert.ok(expansions('protein powder', true).includes('protein powder z'));
});

test('intent rules, with brands as navigational unless compared', () => {
  assert.equal(classifyIntent('buy protein powder online', []), 'transactional');
  assert.equal(classifyIntent('best protein powder for women', []), 'commercial');
  assert.equal(classifyIntent('how much protein powder per day', []), 'informational');
  assert.equal(classifyIntent('myprotein login', ['MyProtein']), 'navigational');
  assert.equal(classifyIntent('myprotein vs optimum', ['MyProtein']), 'commercial');
});

test('keywords merge across engines and rank by agreement', () => {
  const item = (engine: string, text: string, rank: number) =>
    evidence({ source: 'autocomplete', kind: 'keyword', key: `${engine}:${text}`, url: 'u', text, metrics: { rank }, attributes: { engine } });
  const merged = mergeKeywords([item('google', 'a b', 3), item('bing', 'a b', 1), item('youtube', 'a b', 2), item('google', 'c d', 1)], []);
  assert.equal(merged[0].phrase, 'a b');
  assert.deepEqual(merged[0].engines.sort(), ['bing', 'google', 'youtube']);
  assert.equal(merged[0].bestRank, 1);
  assert.ok(merged[0].demand > merged[1].demand);
});

test('ad tiers and score favour longevity and variants', () => {
  assert.equal(tierFor(95), '90+ days observed');
  assert.equal(tierFor(61), '60–89 days observed');
  assert.equal(tierFor(30), '30–59 days observed');
  assert.equal(tierFor(3), 'under 30 days observed');
  assert.ok(scoreAd(90, 1, 1, true) > scoreAd(10, 1, 1, true));
  assert.ok(scoreAd(30, 8, 1, true) > scoreAd(30, 1, 1, true));
  assert.ok(scoreAd(30, 1, 1, true) > scoreAd(30, 1, 1, false));
  assert.equal(conceptKey('Get 20% OFF today! https://x.co'), conceptKey('get  20% off TODAY'));
});

test('identical copy by one advertiser counts as variants', () => {
  const ad = (id: string) => evidence({ source: 'meta-ads', kind: 'ad', key: id, url: id, author: 'Acme', text: 'Same copy here', metrics: { daysRunning: 40 } });
  const scored = scoreAds([ad('1'), ad('2'), ad('3')]);
  assert.ok(scored.every((s) => s.variants === 3));
});

test('engagement normalises by views, then followers', () => {
  const video = evidence({ source: 'tiktok', kind: 'video', url: 'v', metrics: { views: 1000, likes: 80, comments: 10, shares: 5, saves: 5, followers: 1_000_000 } });
  assert.equal(engagementRate(video), 0.1);
  const post = evidence({ source: 'instagram', kind: 'post', url: 'p', metrics: { likes: 90, comments: 10, followers: 10_000 } });
  assert.equal(engagementRate(post), 0.01);
});

test('outlier is measured against the same author when there are enough posts', () => {
  const post = (id: string, likes: number) => evidence({ source: 'tiktok', kind: 'video', key: id, url: id, author: 'a', metrics: { views: 1000, likes } });
  const scored = scorePosts([post('1', 10), post('2', 10), post('3', 10), post('4', 50)]);
  assert.equal(scored.find((s) => s.id === post('4', 0).id)?.outlier, 5);
});

test('website helpers: stack, key pages, inventory, SEO issues', () => {
  assert.deepEqual(detectStack({ scriptSources: ['https://connect.facebook.net/en_US/fbevents.js', 'https://cdn.shopify.com/x.js'], inlineSignals: [], generator: '' }), {
    pixel: ['Meta Pixel'],
    platform: ['Shopify'],
  });
  const pages = pickKeyPages(
    [
      { text: 'Home', href: 'https://a.com/' },
      { text: 'Plans', href: 'https://a.com/plans' },
      { text: 'Acme vs Beta', href: 'https://a.com/compare/beta' },
    ],
    5,
  );
  assert.deepEqual(pages.map((p) => p.label), ['pricing', 'compare']);
  const inv = inventory(['https://a.com/blog/how-to-x', 'https://a.com/blog/y', 'https://a.com/about']);
  assert.equal(inv.sections.blog, 2);
  assert.ok(inv.topics.includes('how to x'));
  const page = evidence({ source: 'website', kind: 'page', url: 'https://a.com', title: 'A', metrics: { titleLength: 1, h1Count: 2, wordCount: 100, imagesWithoutAlt: 0, metaDescriptionLength: 0 }, attributes: { pageType: 'home' } });
  const issues = seoIssues(page);
  assert.ok(!issues.includes('2 H1s')); // multiple H1s alone do not prove an SEO problem
  assert.ok(issues.includes('no meta description'));
  assert.ok(!issues.some((i) => i.startsWith('thin content'))); // no minimum Google word count
});

test('tasks interleave by source so parallel slots hit different hosts', async () => {
  const { interleave } = await import('./research.js');
  const task = (source: 'autocomplete' | 'meta-ads' | 'website', query: string) => ({ source, query, limit: 1, why: '' });
  const order = interleave([task('autocomplete', 'a'), task('autocomplete', 'b'), task('autocomplete', 'c'), task('meta-ads', 'x'), task('website', 'w')]);
  assert.deepEqual(order.map((t) => t.query), ['a', 'x', 'w', 'b', 'c']);
});

test('views without interaction counts give no engagement rate, not zero', () => {
  const video = evidence({ source: 'youtube', kind: 'video', url: 'y', metrics: { views: 50_000 } });
  assert.ok(Number.isNaN(engagementRate(video)));
});

test('search-engine result pages are recognised and everything else is not', async () => {
  const { searchEngineOf } = await import('./core/politeness.js');
  assert.equal(searchEngineOf('https://www.google.com/search?q=x'), 'Google Search');
  assert.equal(searchEngineOf('https://www.google.com.au/search?q=x'), 'Google Search');
  assert.equal(searchEngineOf('https://www.bing.com/search?q=x'), 'Bing');
  assert.equal(searchEngineOf('https://duckduckgo.com/html/?q=x'), 'DuckDuckGo');
  assert.equal(searchEngineOf('https://adstransparency.google.com/?region=AU'), '');
  assert.equal(searchEngineOf('https://www.youtube.com/results?search_query=x'), '');
  assert.equal(searchEngineOf('https://houseofnepal.com.au/search?q=kurta'), '');
});
