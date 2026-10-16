import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteReadiness, combineReadiness, evaluateCrawlerAccess, htmlToText, summarizeVisibility, validateLlmsTxt, wordCount, type PageReadiness } from './geo-audit.js';
import { renderHtml, renderMarkdown } from './report/render.js';
import { EvidenceStore } from './core/store.js';
import type { Report } from './report/synthesize.js';

const page = (over: Partial<PageReadiness> = {}): PageReadiness => ({
  url: 'https://fixture.test/', pageType: 'home', status: 200, title: 'LiftLab activewear', h1: ['LiftLab activewear for women who lift'], wordCount: 600, rawWordCount: 560, rawStatus: 200,
  leadWords: 48, questionHeadings: ['What sizes do you stock?'], lists: 2, tables: 0, dataNosnippet: 0, robotsMeta: '', xRobotsTag: '', jsonLdTypes: ['Organization', 'WebSite'], invalidJsonLd: 0,
  author: '', dateModified: '2026-09-01', datePublished: '2026-01-01', faq: false, organization: { name: 'LiftLab', sameAs: ['https://www.instagram.com/liftlab', 'https://www.linkedin.com/company/liftlab'] }, lang: 'en', ...over,
});
const llms = validateLlmsTxt('# LiftLab\n\n> Activewear for women who lift.\n\n## Key pages\n- [Shop](https://fixture.test/shop): all products\n', 200, 'https://fixture.test/');

test('robots.txt verdicts name the engine each block removes the site from', () => {
  const access = evaluateCrawlerAccess('User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n', ['/products/tee', '/cart']);
  const byToken = Object.fromEntries(access.map((a) => [a.token, a]));
  assert.equal(byToken.GPTBot.allowed, false);
  assert.equal(byToken.GPTBot.byWildcard, false);
  assert.equal(byToken['OAI-SearchBot'].allowed, false);
  assert.match(byToken['OAI-SearchBot'].effect, /ChatGPT search/);
  assert.equal(byToken.PerplexityBot.allowed, false, 'the wildcard /cart rule blocks one sampled path');
  assert.deepEqual(byToken.PerplexityBot.blockedPaths, ['/cart']);
  assert.equal(byToken.PerplexityBot.byWildcard, true);
  assert.equal(byToken.Googlebot.blockedPaths.length, 1);
  assert.equal(evaluateCrawlerAccess(null, []).every((a) => a.allowed), true, 'no robots.txt means no restriction');
  assert.equal(evaluateCrawlerAccess('User-agent: *\nDisallow: /', ['/']).every((a) => !a.allowed), true);
});

test('plain HTML text drops scripts and styles so the JavaScript ratio is honest', () => {
  const text = htmlToText('<html><head><style>p{}</style><script>var a="hidden words here";</script></head><body><h1>Hi &amp; welcome</h1><p>Two<br>words</p><noscript>no</noscript></body></html>');
  assert.equal(text, 'Hi & welcome Two words');
  assert.equal(wordCount(text), 5, 'the same whitespace split as the rendered count, so the ratio compares like with like');
});

test('llms.txt is validated against its published format and HTML is not mistaken for it', () => {
  assert.equal(llms.valid, true);
  assert.equal(llms.title, 'LiftLab');
  assert.equal(llms.sameSiteLinks, 1);
  const html = validateLlmsTxt('<!doctype html><html><body>Not found</body></html>', 200, 'https://fixture.test/');
  assert.equal(html.present, false);
  assert.match(html.problems[0], /HTML page/);
  const bare = validateLlmsTxt('LiftLab\nsome text', 200, 'https://fixture.test/');
  assert.equal(bare.present, true);
  assert.equal(bare.valid, false);
  assert.equal(validateLlmsTxt(null, 404, 'https://fixture.test/').present, false);
});

test('a well-prepared site passes and a blocked, script-rendered, thin site fails with ranked fixes', () => {
  const good = buildSiteReadiness({ website: 'https://fixture.test/', brand: 'LiftLab', robotsBody: 'User-agent: *\nAllow: /', robotsStatus: 200, llmsTxt: llms, pages: [page()], gaps: [] });
  assert.deepEqual(good.findings.filter((f) => f.severity !== 'info'), []);
  assert.equal(good.checks['crawler access'].passed, good.checks['crawler access'].total);

  const bad = buildSiteReadiness({
    website: 'https://fixture.test/', brand: 'LiftLab', robotsBody: 'User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /', robotsStatus: 200,
    llmsTxt: validateLlmsTxt(null, 404, 'https://fixture.test/'),
    pages: [
      page({ wordCount: 900, rawWordCount: 90, leadWords: 8, jsonLdTypes: [], organization: null, title: 'Home', h1: ['Welcome'] }),
      page({ url: 'https://fixture.test/blog/sizing', pageType: 'article', wordCount: 1200, rawWordCount: 1100, questionHeadings: [], dateModified: '', datePublished: '', author: '', robotsMeta: 'noindex, nosnippet' }),
      page({ url: 'https://fixture.test/products/tee', pageType: 'product', rawStatus: 403, rawWordCount: null, jsonLdTypes: [] }),
    ], gaps: ['A sample of pages was checked.'],
  });
  const ids = bad.findings.map((f) => f.id);
  assert.equal(bad.findings[0].severity, 'critical');
  assert.ok(ids.indexOf('search-crawlers-blocked') < ids.indexOf('content-needs-javascript'), 'critical access problems come before content advice');
  for (const id of ['search-crawlers-blocked', 'user-fetchers-blocked', 'html-fetch-refused', 'content-needs-javascript', 'noindex', 'snippets-limited', 'no-direct-answer', 'no-question-headings', 'no-date', 'no-author', 'no-organization-schema', 'brand-not-named', 'no-product-schema', 'no-llms-txt']) assert.ok(ids.includes(id), `expected ${id}`);
  const blocked = bad.findings.find((f) => f.id === 'search-crawlers-blocked')!;
  assert.match(blocked.issue, /OAI-SearchBot/);
  assert.doesNotMatch(blocked.issue, /Googlebot/, 'the named Googlebot group is allowed');
  assert.match(blocked.issue, /wildcard/);
  assert.equal(bad.findings.find((f) => f.id === 'no-llms-txt')!.severity, 'info');
  assert.ok(bad.caveats.some((c) => /third-party/.test(c)));
});

test('visibility summary counts brand mentions, own-site citations and who was cited instead', () => {
  const { observations, summary } = summarizeVisibility([
    { provider: 'ChatGPT', prompt: 'best activewear in Australia', status: 'complete', answer: 'Popular picks are Gymshark and Lorna Jane. LiftLabs is different.', citations: ['https://www.reddit.com/r/xxfitness/1', 'https://www.gymshark.com/au'], observedAt: '', note: '' },
    { provider: 'Perplexity', prompt: 'is liftlab good', status: 'complete', answer: 'LiftLab makes gym wear; reviews are mixed.', citations: ['https://fixture.test/reviews', 'https://reddit.com/r/au'], observedAt: '', note: '' },
    { provider: 'Perplexity', prompt: 'cost', status: 'blocked', answer: '', citations: [], observedAt: '', note: 'blocked' },
  ], { brand: 'LiftLab', website: 'https://www.fixture.test/', competitors: ['Gymshark', 'Lorna Jane'] });
  assert.equal(observations[0].brandMentioned, false, 'LiftLabs is a different word');
  assert.equal(observations[1].brandMentioned, true);
  assert.equal(observations[1].ownSiteCited, true);
  assert.deepEqual(summary.citedHosts[0], { host: 'reddit.com', count: 2 });
  assert.deepEqual(summary.competitorMentions, [{ name: 'Gymshark', count: 1 }, { name: 'Lorna Jane', count: 1 }]);
  assert.equal(summary.brandMentions, 1);
  assert.equal(summary.blocked, 1);
  assert.deepEqual(summary.findings, [], 'a mentioned and cited brand raises no visibility finding');
  const unseen = summarizeVisibility([
    { provider: 'ChatGPT', prompt: 'a', status: 'complete', answer: 'Try Gymshark.', citations: ['https://gymshark.com'], observedAt: '', note: '' },
    { provider: 'ChatGPT', prompt: 'b', status: 'complete', answer: 'Lorna Jane is popular.', citations: [], observedAt: '', note: '' },
  ], { brand: 'LiftLab', website: 'https://fixture.test', competitors: ['Gymshark', 'Lorna Jane'] });
  assert.equal(unseen.summary.findings[0].id, 'brand-not-mentioned');
  assert.match(unseen.summary.findings[0].issue, /Gymshark \(1\)/);
});

test('the report renders the readiness section with its caveats in both formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-geo-'));
  try {
    const store = new EvidenceStore(dir);
    const site = buildSiteReadiness({ website: 'https://fixture.test/', brand: 'LiftLab', robotsBody: 'User-agent: *\nDisallow: /', robotsStatus: 200, llmsTxt: llms, pages: [page()], gaps: [] });
    const brief = { product: 'Activewear', niche: 'activewear', brand: 'LiftLab', ownWebsite: 'https://fixture.test/', competitors: [], websites: ['https://fixture.test/'], country: 'AU', language: 'en', audience: '', goals: [], sources: [] } as Report['brief'];
    const report: Report = { version: 3, status: 'partial', brief, generatedAt: '2026-10-16T00:00:00.000Z', headline: 'h', executiveSummary: [], sections: [], recommendations: [], caveats: [], coverage: [], cost: '$0',
      insights: { keywords: { topKeywords: [], questions: [], clusters: [], intents: {} } as never, ads: { winners: [], total: 0, advertisers: [], hooks: [], angles: [], awareness: [], ctas: [] } as never, social: { topByPlatform: {}, voc: [] } as never, competitors: [] },
      aiReadiness: combineReadiness(site, { prompts: ['q'], ...summarizeVisibility([{ provider: 'ChatGPT', prompt: 'q', status: 'complete', answer: 'Gymshark is popular. '.repeat(10), citations: ['https://reddit.com/x'], observedAt: '', note: '' }, { provider: 'ChatGPT', prompt: 'r', status: 'complete', answer: 'Lorna Jane. '.repeat(20), citations: [], observedAt: '', note: '' }], { brand: 'LiftLab', website: 'https://fixture.test/', competitors: ['Gymshark'] }) }) };
    const html = renderHtml(report, store), md = renderMarkdown(report, store);
    for (const text of [html, md]) {
      assert.match(text, /AI search readiness/);
      assert.match(text, /OAI-SearchBot/);
      assert.match(text, /not mentioned in any of 2 completed answers/);
      assert.match(text, /do not predict/i);
    }
    assert.match(html, /sev-critical/);
    assert.match(html, /reddit\.com \(1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
