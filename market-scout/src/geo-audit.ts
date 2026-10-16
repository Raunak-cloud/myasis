import { parseRobots } from './core/robots.js';
import { askJson, type CostMeter } from './llm/celeris.js';
import type { Brief } from './core/types.js';

/**
 * AI-search readiness ("GEO") measured by code from what a site actually
 * serves. Every check here is a fact about the page or robots.txt, with the
 * documented consequence stated next to it; none is a ranking prediction.
 *
 * Sources for the consequences, checked 16 Oct 2026:
 * - developers.openai.com/api/docs/bots — OAI-SearchBot decides ChatGPT search
 *   inclusion; GPTBot is training only; ChatGPT-User is user-triggered.
 * - support.claude.com (crawler article) — Claude-SearchBot indexes for search,
 *   Claude-User fetches for a user's question, ClaudeBot is training.
 * - docs.perplexity.ai/guides/bots — PerplexityBot surfaces sites in answers;
 *   Perplexity-User fetches on request and generally ignores robots.txt.
 * - developers.google.com/search/docs/appearance/ai-features — Googlebot's
 *   rules cover AI Overviews and AI Mode; no AI-specific markup or file is
 *   needed; nosnippet/max-snippet/noindex limit what AI features show.
 * - developers.google.com/.../google-common-crawlers — Google-Extended only
 *   governs Gemini training and grounding, never Search inclusion.
 * - llmstxt.org — the llms.txt format. Adoption is uneven and no engine has
 *   published that it changes citations, so it is reported as optional.
 */

export interface CrawlerRule {
  token: string;
  vendor: string;
  role: 'search' | 'user-fetch' | 'training';
  /** What a block does, in the vendor's own terms. */
  effect: string;
}

export const AI_CRAWLERS: CrawlerRule[] = [
  { token: 'OAI-SearchBot', vendor: 'OpenAI', role: 'search', effect: 'Sites that block OAI-SearchBot are not shown in ChatGPT search answers.' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', role: 'user-fetch', effect: 'Stops ChatGPT opening your pages when a user asks about them; robots rules may not apply to user-triggered visits.' },
  { token: 'GPTBot', vendor: 'OpenAI', role: 'training', effect: 'Excludes future content from OpenAI training. Does not affect ChatGPT search inclusion.' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', role: 'search', effect: 'Stops indexing for Claude search, which may reduce visibility and accuracy in its results.' },
  { token: 'Claude-User', vendor: 'Anthropic', role: 'user-fetch', effect: 'Stops Claude retrieving your pages for a user’s question.' },
  { token: 'ClaudeBot', vendor: 'Anthropic', role: 'training', effect: 'Excludes future content from Anthropic training. Does not affect Claude search.' },
  { token: 'PerplexityBot', vendor: 'Perplexity', role: 'search', effect: 'Your site is not surfaced or linked in Perplexity answers.' },
  { token: 'Perplexity-User', vendor: 'Perplexity', role: 'user-fetch', effect: 'Controls fetches made for a user’s question; Perplexity says this fetcher generally ignores robots.txt.' },
  { token: 'Googlebot', vendor: 'Google', role: 'search', effect: 'Googlebot rules decide Google Search, AI Overviews and AI Mode. A block removes the site from all of them.' },
  { token: 'Google-Extended', vendor: 'Google', role: 'training', effect: 'Opts out of Gemini training and grounding. Does not affect Search, AI Overviews or AI Mode.' },
  { token: 'bingbot', vendor: 'Microsoft', role: 'search', effect: 'Removes the site from Bing, whose index other assistants also draw on.' },
  { token: 'CCBot', vendor: 'Common Crawl', role: 'training', effect: 'Excludes the site from the Common Crawl corpus used to train many open models.' },
];

export interface CrawlerAccess extends CrawlerRule {
  /** Paths from the sampled pages that the token may not fetch. */
  blockedPaths: string[];
  sampledPaths: number;
  allowed: boolean;
  /** The rule came from a `*` group rather than one naming this token. */
  byWildcard: boolean;
}

/** Each AI crawler's access to the sampled paths under this robots.txt. */
export function evaluateCrawlerAccess(robotsBody: string | null, paths: string[]): CrawlerAccess[] {
  const sampled = [...new Set(['/', ...paths.map((p) => { try { return new URL(p, 'https://x.invalid').pathname; } catch { return ''; } }).filter(Boolean)])];
  const named = new Set((robotsBody ?? '').toLowerCase().match(/^\s*user-agent\s*:\s*([^\s#]+)/gim)?.map((line) => line.replace(/^\s*user-agent\s*:\s*/i, '').trim()) ?? []);
  return AI_CRAWLERS.map((rule) => {
    const rules = parseRobots(robotsBody ?? '', rule.token);
    const blockedPaths = sampled.filter((path) => !rules.isAllowed(path));
    return { ...rule, blockedPaths, sampledPaths: sampled.length, allowed: blockedPaths.length === 0, byWildcard: !named.has(rule.token.toLowerCase()) };
  });
}

/** Text an HTML-only client sees: no scripts, no rendering. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|#160);/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" })[m]!)
    .replace(/\s+/g, ' ')
    .trim();
}

export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

export interface LlmsTxtCheck {
  status: number | null;
  present: boolean;
  /** Follows llmstxt.org: an H1, then an optional blockquote, then H2 link lists. */
  valid: boolean;
  title: string;
  summary: string;
  links: number;
  sameSiteLinks: number;
  problems: string[];
}

export function validateLlmsTxt(body: string | null, status: number | null, site: string): LlmsTxtCheck {
  const result: LlmsTxtCheck = { status, present: false, valid: false, title: '', summary: '', links: 0, sameSiteLinks: 0, problems: [] };
  if (status !== 200 || body === null) return result;
  if (/^\s*<(!doctype|html)/i.test(body)) { result.problems.push('The URL returns an HTML page, not a Markdown file.'); return result; }
  result.present = true;
  const lines = body.replace(/^﻿/, '').split(/\r?\n/);
  const first = lines.find((line) => line.trim());
  const h1 = /^#\s+(.+)/.exec(first ?? '');
  if (!h1) result.problems.push('The first line must be an H1 with the site or project name.');
  result.title = h1?.[1].trim() ?? '';
  result.summary = lines.find((line) => /^>\s*\S/.test(line))?.replace(/^>\s*/, '').trim() ?? '';
  if (!result.summary) result.problems.push('Add a one-paragraph blockquote summary under the title.');
  const host = (() => { try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  for (const match of body.matchAll(/^\s*[-*]\s+\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gm)) {
    result.links++;
    try { if (new URL(match[1]).hostname.replace(/^www\./, '') === host) result.sameSiteLinks++; } catch { /* a malformed link is still a link attempt */ }
  }
  if (!/^##\s+\S/m.test(body)) result.problems.push('Add H2 sections listing key pages as Markdown links.');
  if (!result.links) result.problems.push('No Markdown links were found; the file should point to the pages that explain the business.');
  result.valid = Boolean(h1) && result.links > 0;
  return result;
}

/** Facts measured on one page for the readiness checks. */
export interface PageReadiness {
  url: string;
  pageType: string;
  status: number | null;
  title: string;
  h1: string[];
  wordCount: number;
  /** Words an HTML-only fetch returned, or null when the fetch was refused. */
  rawWordCount: number | null;
  rawStatus: number | null;
  /** Words in the first paragraph after the main heading. */
  leadWords: number;
  questionHeadings: string[];
  lists: number;
  tables: number;
  dataNosnippet: number;
  robotsMeta: string;
  xRobotsTag: string;
  jsonLdTypes: string[];
  invalidJsonLd: number;
  author: string;
  dateModified: string;
  datePublished: string;
  faq: boolean;
  organization: { name: string; sameAs: string[] } | null;
  lang: string;
}

export interface ReadinessFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  area: 'crawler access' | 'rendering' | 'content' | 'structured data' | 'entity' | 'visibility' | 'files';
  issue: string;
  fix: string;
  /** Pages or resources that show the issue. */
  where: string[];
  affects: string[];
}

export interface SiteReadiness {
  checkedAt: string;
  website: string;
  brand: string;
  crawlers: CrawlerAccess[];
  llmsTxt: LlmsTxtCheck;
  pages: PageReadiness[];
  /** Checks passed over checks run, per area. Not a ranking score. */
  checks: Record<ReadinessFinding['area'], { passed: number; total: number }>;
  findings: ReadinessFinding[];
  caveats: string[];
}

const SEARCH_ENGINES = ['ChatGPT', 'Claude', 'Perplexity', 'Google AI'];
const contentPage = (page: PageReadiness) => page.wordCount >= 150 && !/^(home|pricing|shop|contact|about|legal|listing)$/.test(page.pageType);

/** Deterministic findings from the measured facts. */
export function buildSiteReadiness(input: { website: string; brand: string; robotsBody: string | null; robotsStatus: number | null; llmsTxt: LlmsTxtCheck; pages: PageReadiness[]; gaps: string[] }): SiteReadiness {
  const findings: ReadinessFinding[] = [];
  const checks: SiteReadiness['checks'] = { 'crawler access': { passed: 0, total: 0 }, rendering: { passed: 0, total: 0 }, content: { passed: 0, total: 0 }, 'structured data': { passed: 0, total: 0 }, entity: { passed: 0, total: 0 }, visibility: { passed: 0, total: 0 }, files: { passed: 0, total: 0 } };
  const check = (area: ReadinessFinding['area'], ok: boolean, finding?: Omit<ReadinessFinding, 'area'>) => {
    checks[area].total++;
    if (ok) checks[area].passed++;
    else if (finding) findings.push({ area, ...finding });
  };
  const pages = input.pages.filter((p) => p.status !== null && p.status < 400);
  const crawlers = evaluateCrawlerAccess(input.robotsBody, pages.map((p) => p.url));
  const vendorsAffected = (rules: CrawlerAccess[]) => [...new Set(rules.map((r) => ({ OpenAI: 'ChatGPT', Anthropic: 'Claude', Perplexity: 'Perplexity', Google: 'Google AI', Microsoft: 'Bing' } as Record<string, string>)[r.vendor] ?? r.vendor))];

  // Crawler access: search and user fetchers decide whether an assistant can cite the site at all.
  if (input.robotsStatus !== null && input.robotsStatus >= 500) {
    check('crawler access', false, { id: 'robots-unreadable', severity: 'critical', issue: `robots.txt answered HTTP ${input.robotsStatus}. Crawlers that cannot read it treat the whole site as off limits.`, fix: 'Serve robots.txt with HTTP 200 (or 404 if you have none).', where: [`${input.website}robots.txt`], affects: SEARCH_ENGINES });
  } else check('crawler access', true);
  const blockedSearch = crawlers.filter((c) => c.role === 'search' && !c.allowed);
  check('crawler access', !blockedSearch.length, blockedSearch.length ? { id: 'search-crawlers-blocked', severity: 'critical', issue: `robots.txt blocks ${blockedSearch.map((c) => c.token).join(', ')}${blockedSearch.some((c) => c.byWildcard) ? ' (through a wildcard rule)' : ''}. ${blockedSearch.map((c) => c.effect).join(' ')}`, fix: `Allow these tokens for the pages you want cited: ${blockedSearch.map((c) => `User-agent: ${c.token} / Allow: /`).join('; ')}. Changes take effect at the next crawl (OpenAI quotes about 24 hours).`, where: blockedSearch.flatMap((c) => c.blockedPaths.slice(0, 4)), affects: vendorsAffected(blockedSearch) } : undefined);
  const blockedUser = crawlers.filter((c) => c.role === 'user-fetch' && !c.allowed);
  check('crawler access', !blockedUser.length, blockedUser.length ? { id: 'user-fetchers-blocked', severity: 'high', issue: `robots.txt blocks ${blockedUser.map((c) => c.token).join(', ')}, the fetchers assistants use when a person asks about your pages.`, fix: 'Allow these tokens unless you have a reason to hide pages from live answers.', where: blockedUser.flatMap((c) => c.blockedPaths.slice(0, 4)), affects: vendorsAffected(blockedUser) } : undefined);
  const trainingBlocked = crawlers.filter((c) => c.role === 'training' && !c.allowed);
  if (trainingBlocked.length) findings.push({ id: 'training-crawlers-blocked', area: 'crawler access', severity: 'info', issue: `Training crawlers blocked: ${trainingBlocked.map((c) => c.token).join(', ')}. This is a policy choice, not a visibility problem; it does not affect search inclusion.`, fix: 'No change needed unless you want future models trained on your content.', where: [`${input.website}robots.txt`], affects: [] });

  // Rendering: assistants fetch HTML without running scripts.
  for (const page of pages) {
    if (page.rawStatus !== null && page.rawStatus >= 400) {
      check('rendering', false, { id: 'html-fetch-refused', severity: 'critical', issue: `A plain HTTP client was refused with HTTP ${page.rawStatus}, while a browser could load the page. AI fetchers are plain clients, so they likely see the same refusal.`, fix: 'Check the CDN or bot-protection rules (Cloudflare, Akamai, Vercel firewall) and allow the AI search user agents above.', where: [page.url], affects: SEARCH_ENGINES });
      continue;
    }
    if (page.rawWordCount === null) { continue; }
    const ratio = page.wordCount ? page.rawWordCount / page.wordCount : 1;
    check('rendering', ratio >= 0.6 || page.wordCount < 80, ratio < 0.6 && page.wordCount >= 80 ? { id: 'content-needs-javascript', severity: ratio < 0.3 ? 'high' : 'medium', issue: `Only ${Math.round(ratio * 100)}% of the page’s words are in the HTML the server sends; the rest appears after JavaScript runs. Fetchers that do not execute scripts miss it.`, fix: 'Render the main text on the server (SSR or static output), or pre-render for crawlers.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
  }

  // Snippet and index controls limit what any engine, including AI features, may quote.
  for (const page of pages) {
    const controls = `${page.robotsMeta} ${page.xRobotsTag}`.toLowerCase();
    check('crawler access', !/noindex/.test(controls), /noindex/.test(controls) ? { id: 'noindex', severity: page.pageType === 'home' ? 'critical' : 'high', issue: 'The page is marked noindex, so it cannot appear in search or be cited by AI features that rely on the index.', fix: 'Remove noindex if this page should be found.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
    const snippetLimited = /nosnippet|max-snippet:\s*0\b/.test(controls);
    check('content', !snippetLimited && page.dataNosnippet === 0, snippetLimited || page.dataNosnippet ? { id: 'snippets-limited', severity: 'medium', issue: `${snippetLimited ? 'nosnippet or max-snippet:0 is set' : `${page.dataNosnippet} data-nosnippet block(s)`} on this page. Google honours these in AI Overviews and AI Mode, so the covered text cannot be quoted.`, fix: 'Keep snippet controls only on text you truly do not want quoted.', where: [page.url], affects: ['Google AI'] } : undefined);
  }

  // Content: answer-first text is what gets lifted into answers. Legal pages are not answers.
  for (const page of pages.filter((p) => p.pageType !== 'legal' && p.pageType !== 'listing')) {
    if (page.wordCount < 80) { check('content', false, { id: 'thin-page', severity: page.pageType === 'home' ? 'high' : 'medium', issue: `Only ${page.wordCount} words are visible; there is little an assistant can quote.`, fix: 'State what the business offers, for whom, where, and the price basis in plain sentences.', where: [page.url], affects: SEARCH_ENGINES }); continue; }
    check('content', page.h1.length > 0, !page.h1.length ? { id: 'no-h1', severity: 'medium', issue: 'No main heading, so the page topic is not stated up front.', fix: 'Add one H1 that names the page’s subject.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
    check('content', page.leadWords >= 25, page.leadWords < 25 ? { id: 'no-direct-answer', severity: 'medium', issue: `The first paragraph after the heading has ${page.leadWords} words. Answers lift a page’s opening statement; a short or missing one gives nothing to quote.`, fix: 'Open with 40–80 words that answer the page’s question directly (who, what, where, price basis), then give detail.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
    if (contentPage(page)) {
      check('content', page.questionHeadings.length > 0 || page.faq, !(page.questionHeadings.length || page.faq) ? { id: 'no-question-headings', severity: 'low', issue: 'No heading is phrased as a question and there is no FAQ, so the page does not map onto the questions people ask assistants.', fix: 'Add H2/H3 headings in the buyer’s own question wording, each followed by a direct answer.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
      check('content', Boolean(page.dateModified || page.datePublished), !(page.dateModified || page.datePublished) ? { id: 'no-date', severity: 'low', issue: 'No publication or modified date is exposed, so freshness cannot be judged.', fix: 'Add datePublished/dateModified in Article schema and a visible "Updated" date.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
      check('content', Boolean(page.author), !page.author ? { id: 'no-author', severity: 'low', issue: 'No author is named on this content page.', fix: 'Add a byline and an author in schema, linking to an about or profile page.', where: [page.url], affects: SEARCH_ENGINES } : undefined);
    }
  }

  // Structured data and entity: how engines confirm who you are.
  const home = pages.find((p) => p.pageType === 'home') ?? pages[0];
  const invalid = pages.filter((p) => p.invalidJsonLd > 0);
  check('structured data', !invalid.length, invalid.length ? { id: 'invalid-json-ld', severity: 'medium', issue: `${invalid.length} page(s) carry JSON-LD that does not parse; engines ignore broken blocks.`, fix: 'Validate the blocks with the Schema Markup Validator and fix the JSON.', where: invalid.map((p) => p.url), affects: SEARCH_ENGINES } : undefined);
  if (home) {
    check('structured data', Boolean(home.organization), !home.organization ? { id: 'no-organization-schema', severity: 'medium', issue: 'The homepage has no Organization or LocalBusiness schema, so engines must infer the business name, location and links.', fix: 'Add Organization (or LocalBusiness) JSON-LD with name, url, logo, address and sameAs.', where: [home.url], affects: SEARCH_ENGINES } : undefined);
    const sameAs = home.organization?.sameAs ?? [];
    check('entity', sameAs.length >= 2, home.organization && sameAs.length < 2 ? { id: 'few-sameas', severity: 'low', issue: `Organization schema lists ${sameAs.length} sameAs link(s). Engines reconcile a brand across its profiles.`, fix: 'List the official LinkedIn, Wikipedia/Wikidata (if any), Google Business Profile, and social profiles in sameAs.', where: [home.url], affects: SEARCH_ENGINES } : undefined);
    if (input.brand) {
      const named = `${home.title} ${home.h1.join(' ')} ${home.organization?.name ?? ''}`.toLowerCase().includes(input.brand.toLowerCase());
      check('entity', named, !named ? { id: 'brand-not-named', severity: 'medium', issue: `The brand name "${input.brand}" does not appear in the homepage title, H1 or Organization schema.`, fix: 'Name the brand consistently in the title, main heading and schema so mentions elsewhere resolve to this site.', where: [home.url], affects: SEARCH_ENGINES } : undefined);
    }
  }
  for (const page of pages.filter((p) => /product/.test(p.pageType))) check('structured data', page.jsonLdTypes.some((t) => /Product|Offer|Service/i.test(t)), !page.jsonLdTypes.some((t) => /Product|Offer|Service/i.test(t)) ? { id: 'no-product-schema', severity: 'low', issue: 'A product or service page without Product/Service schema; price and availability must be inferred from prose.', fix: 'Add Product or Service JSON-LD with offers, price, currency and availability.', where: [page.url], affects: SEARCH_ENGINES } : undefined);

  // Files: optional, reported honestly.
  if (input.llmsTxt.present) {
    check('files', input.llmsTxt.valid, !input.llmsTxt.valid ? { id: 'llms-txt-invalid', severity: 'low', issue: `llms.txt exists but does not follow the format: ${input.llmsTxt.problems.join(' ')}`, fix: 'Follow llmstxt.org: an H1, a blockquote summary, then H2 sections of Markdown links.', where: [`${input.website}llms.txt`], affects: [] } : undefined);
  } else findings.push({ id: 'no-llms-txt', area: 'files', severity: 'info', issue: 'No llms.txt. Anthropic and Perplexity have said they read it; Google says it needs no AI-specific file, and no engine has published evidence that it changes citations.', fix: 'Optional: publish a short llms.txt pointing to your key pages. Do not expect it to replace the checks above.', where: [`${input.website}llms.txt`], affects: [] });

  const order: Record<ReadinessFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  // One row per issue; the pages it affects are merged.
  const merged = new Map<string, ReadinessFinding>();
  for (const f of findings) {
    const existing = merged.get(f.id);
    if (existing) existing.where = [...new Set([...existing.where, ...f.where])];
    else merged.set(f.id, { ...f });
  }
  return {
    checkedAt: new Date().toISOString(), website: input.website, brand: input.brand, crawlers, llmsTxt: input.llmsTxt, pages: input.pages, checks,
    findings: [...merged.values()].sort((a, b) => order[a.severity] - order[b.severity]),
    caveats: [
      ...input.gaps,
      'Checks describe what the site serves today and the documented behaviour of each engine. They do not predict whether, or how often, an assistant will cite the site.',
      'Independent citation studies find most assistant citations go to third-party pages (Reddit, Wikipedia, YouTube, review sites, news). Earning accurate mentions there matters at least as much as on-site changes.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Visibility: what assistants actually answered, and who they cited instead.
// ---------------------------------------------------------------------------

export interface VisibilityObservation {
  provider: string;
  prompt: string;
  status: 'complete' | 'blocked' | 'unavailable';
  answer: string;
  citations: string[];
  observedAt: string;
  note: string;
  brandMentioned?: boolean;
  ownSiteCited?: boolean;
  competitorsMentioned?: string[];
  citedHosts?: string[];
}

export interface VisibilitySummary {
  prompts: number;
  complete: number;
  blocked: number;
  brandMentions: number;
  ownSiteCitations: number;
  /** Hosts cited across complete answers, most cited first. */
  citedHosts: Array<{ host: string; count: number }>;
  competitorMentions: Array<{ name: string; count: number }>;
  findings: ReadinessFinding[];
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const mentions = (text: string, name: string) => Boolean(name.trim()) && new RegExp(`(^|[^\\p{L}\\p{N}])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);

export function summarizeVisibility(observations: VisibilityObservation[], input: { brand: string; website?: string; competitors: string[] }): { observations: VisibilityObservation[]; summary: VisibilitySummary } {
  const site = input.website ? hostOf(input.website) : '';
  const hostCounts = new Map<string, number>();
  const competitorCounts = new Map<string, number>();
  const annotated = observations.map((o) => {
    if (o.status !== 'complete') return o;
    const citedHosts = [...new Set(o.citations.map(hostOf).filter(Boolean))];
    for (const host of citedHosts) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    const competitorsMentioned = input.competitors.filter((name) => mentions(o.answer, name));
    for (const name of competitorsMentioned) competitorCounts.set(name, (competitorCounts.get(name) ?? 0) + 1);
    return { ...o, citedHosts, brandMentioned: mentions(o.answer, input.brand), ownSiteCited: Boolean(site) && citedHosts.some((h) => h === site || h.endsWith(`.${site}`)), competitorsMentioned };
  });
  const complete = annotated.filter((o) => o.status === 'complete');
  const summary: VisibilitySummary = {
    prompts: observations.length, complete: complete.length, blocked: observations.filter((o) => o.status === 'blocked').length,
    brandMentions: complete.filter((o) => o.brandMentioned).length, ownSiteCitations: complete.filter((o) => o.ownSiteCited).length,
    citedHosts: [...hostCounts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    competitorMentions: [...competitorCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    findings: [],
  };
  const providers = [...new Set(complete.map((o) => o.provider))];
  if (complete.length >= 2 && input.brand && !summary.brandMentions) {
    summary.findings.push({ id: 'brand-not-mentioned', area: 'visibility', severity: 'high', issue: `${input.brand} was not mentioned in any of ${complete.length} completed answers on ${providers.join(' and ')}. ${summary.competitorMentions.length ? `Mentioned instead: ${summary.competitorMentions.map((c) => `${c.name} (${c.count})`).join(', ')}.` : ''}`, fix: `Earn accurate mentions on the pages these answers cite (${summary.citedHosts.slice(0, 5).map((h) => h.host).join(', ') || 'none recorded'}): reviews, directories, community threads and comparison articles.`, where: complete.map((o) => o.prompt), affects: providers });
  } else if (complete.length >= 2 && site && !summary.ownSiteCitations) {
    summary.findings.push({ id: 'site-not-cited', area: 'visibility', severity: 'medium', issue: `${site} was not cited in any completed answer${summary.brandMentions ? ', although the brand was mentioned' : ''}.`, fix: 'Publish answer-first pages for these prompts and make sure the search crawlers above can fetch them.', where: complete.map((o) => o.prompt), affects: providers });
  }
  return { observations: annotated, summary };
}

/** Buyer-style prompts worth sampling, from the brief; a fixed fallback keeps the check running without a model. */
export async function suggestVisibilityPrompts(brief: Pick<Brief, 'product' | 'niche' | 'brand' | 'country' | 'competitors' | 'audience'>, meter?: CostMeter, limit = 4): Promise<string[]> {
  const place = ({ AU: 'Australia', NZ: 'New Zealand', GB: 'the UK', US: 'the US', CA: 'Canada' } as Record<string, string>)[brief.country.toUpperCase()] ?? brief.country;
  const fallback = [
    `What are the best ${brief.niche} options in ${place}?`,
    brief.brand ? `Is ${brief.brand} a good choice for ${brief.niche}? What do customers say?` : `How do I choose ${brief.niche} in ${place}?`,
    brief.competitors[0] && brief.brand ? `${brief.brand} vs ${brief.competitors[0]}: which is better?` : `Which ${brief.niche} brands do people in ${place} recommend?`,
    `How much does ${brief.niche} cost in ${place}?`,
  ].filter((p, i, a) => a.indexOf(p) === i).slice(0, limit);
  try {
    const reply = await askJson<{ prompts: string[] }>({
      model: 'celeris-1-magnus', meter, maxTokens: 800, thinking: false,
      system: 'You write the questions a real buyer would type into an AI assistant before choosing a product or service. Plain, specific, one sentence each. Never invent brands that are not supplied.',
      prompt: `Product: ${brief.product}\nCategory: ${brief.niche}\nBrand: ${brief.brand || '(none)'}\nCompetitors: ${brief.competitors.join(', ') || '(none)'}\nMarket: ${place}\nAudience: ${brief.audience || '(unknown)'}\n\nWrite ${limit} distinct buyer questions covering: a "best options in ${place}" question, a comparison or recommendation question, a cost or "is it worth it" question, and one how-to or suitability question. Mention the brand in at most one question.`,
      schema: { type: 'object', properties: { prompts: { type: 'array', items: { type: 'string' } } }, required: ['prompts'] },
    });
    const prompts = (reply.prompts ?? []).filter((p): p is string => typeof p === 'string' && p.trim().length >= 10 && p.length <= 300).map((p) => p.trim()).filter((p, i, a) => a.indexOf(p) === i).slice(0, limit);
    return prompts.length >= 2 ? prompts : fallback;
  } catch {
    return fallback;
  }
}

export interface AiReadiness {
  site: SiteReadiness | null;
  visibility: { prompts: string[]; observations: VisibilityObservation[]; summary: VisibilitySummary } | null;
  /** All findings across site and visibility, most severe first. */
  findings: ReadinessFinding[];
}

export function combineReadiness(site: SiteReadiness | null, visibility: AiReadiness['visibility']): AiReadiness {
  const order: Record<ReadinessFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const findings = [...(site?.findings ?? []), ...(visibility?.summary.findings ?? [])].sort((a, b) => order[a.severity] - order[b.severity]);
  return { site, visibility, findings };
}
