import { reviewEvidence, unsupportedClaim, type QualitySummary } from '../core/quality.js';
import { shortSeed, verifiedCandidate } from '../core/discovery.js';
import { buildMarketingPlan, type MarketingPlan } from './planning.js';
import { siteProfiles } from '../insights/competitors.js';
import { mergeKeywords } from '../insights/keywords.js';
import { scoreAds } from '../insights/ads.js';
import { scorePosts } from '../insights/social.js';
import type { EvidenceStore } from '../core/store.js';
import type { Brief, TaskResult } from '../core/types.js';
import { type CostMeter } from '../llm/celeris.js';
import type { AdInsights } from '../insights/ads.js';
import type { SiteProfile } from '../insights/competitors.js';
import type { KeywordInsights } from '../insights/keywords.js';
import type { SocialInsights } from '../insights/social.js';

export interface Insights {
  keywords: KeywordInsights;
  ads: AdInsights;
  social: SocialInsights;
  competitors: SiteProfile[];
}

export interface Finding {
  finding: string;
  soWhat: string;
  basis: 'observed' | 'inferred';
  evidence: string[];
  check?: string;
}

export function canPublish(finding: Finding): boolean {
  return finding.check === 'supported' && finding.evidence.length > 0 && !unsupportedClaim(`${finding.finding} ${finding.soWhat}`);
}

export interface Recommendation {
  action: string;
  channel: string;
  hypothesis: string;
  evidence: string[];
}

export interface Report {
  version?: number;
  status?: 'ready' | 'partial';
  quality?: QualitySummary;
  brief: Brief;
  generatedAt: string;
  headline: string;
  executiveSummary: Array<Finding & { action: string }>;
  sections: Array<{ id: string; title: string; findings: Finding[] }>;
  recommendations: Recommendation[];
  caveats: string[];
  insights: Insights;
  coverage: TaskResult[];
  cost: string;
  marketingPlan?: MarketingPlan;
}

/** Revalidate public details too: a model summary is never a price source. */
export function publicInsights(insights: Insights, store: EvidenceStore, brief: Brief): Insights {
  const { evidence: items } = reviewEvidence(store.all(), brief);
  const byId = new Map(items.map((p) => [p.id, p]));
  const keywords = mergeKeywords(items, [brief.brand, ...brief.competitors]);
  const ads = scoreAds(items);
  const posts = scorePosts(items);
  return {
    ...insights,
    keywords: { ...insights.keywords, total: keywords.length, topKeywords: keywords.slice(0, 80), questions: keywords.filter((k) => k.isQuestion).map((k) => k.phrase), clusters: [] },
    ads: { ...insights.ads, total: ads.length, winners: ads.sort((a, b) => b.score - a.score).slice(0, 60), angles: [], patterns: { hook: [], awareness: [], offer: [], proof: [], emotion: [], cta: [] } },
    social: { ...insights.social, posts: posts.length, topByPlatform: Object.fromEntries([...new Set(posts.map((p) => p.source))].map((platform) => [platform, posts.filter((p) => p.source === platform).sort((a, b) => (Number.isFinite(b.outlier) ? b.outlier : 0) - (Number.isFinite(a.outlier) ? a.outlier : 0)).slice(0, 12)])), voc: insights.social.voc.flatMap((t) => {
      const quotes = t.quotes.filter((q) => { const p = byId.get(q.evidenceId); return p?.attributes.reviewRole === 'customer' && p.text.includes(q.quote); }).map((q) => ({ ...q, url: byId.get(q.evidenceId)!.url }));
      return quotes.length ? [{ ...t, theme: 'Collected customer-source quotations', mentions: new Set(quotes.map((q) => q.evidenceId)).size, quotes }] : [];
    }) },
    competitors: siteProfiles(items),
  };
}

/** The same evidence gate protects saved reports and newly generated ones. */
export function preparePublicReport(report: Report, store: EvidenceStore): Report {
  const reviewed = reviewEvidence(store.all(), report.brief);
  const insights = publicInsights(report.insights, store, report.brief);
  const supported = [2, 3].includes(report.version ?? 0);
  const sections = supported ? measuredSections(insights, store) : [];
  const discovery = report.brief.discovery;
  const usableIds = new Set(reviewed.evidence.map((p) => p.id));
  const brief = discovery ? { ...report.brief, niche: discovery.categoryBasis === 'suggested' ? shortSeed(report.brief.niche) : report.brief.niche, discovery: { ...discovery, competitors: discovery.competitors.flatMap((c) => {
    const page = usableIds.has(c.evidenceId) ? store.get(c.evidenceId) : undefined;
    const checked = page ? verifiedCandidate(page, { relevant: true, name: c.name, productQuote: c.productQuote, marketQuote: c.marketQuote }, report.brief.country) : undefined;
    return checked ? [checked] : [];
  }) } } : report.brief;
  return { ...report, headline: `Research findings for ${brief.brand || brief.niche || brief.product}`, status: sections.length && report.coverage.every((r) => r.ok) && !(brief.autoDiscover && !brief.websites.length) ? 'ready' : 'partial', brief, insights, quality: reviewed.quality, sections, executiveSummary: sections.map((s) => ({ ...s.findings[0], action: 'Choose a suggested test below and measure the result.' })).slice(0, 5), recommendations: supported ? buildRecommendations(insights) : [], marketingPlan: supported ? buildMarketingPlan(brief, reviewed.evidence) : undefined };
}

/** Build public findings from measurements and exact records, not model verdicts.
 * AI still groups keywords, tags ads and reads seller positioning, but cannot
 * turn those interpretations into market-wide demand or performance claims. */
export function measuredSections(insights: Insights, store: EvidenceStore): Report['sections'] {
  const sections: Report['sections'] = [];
  const add = (id: string, title: string, candidates: Finding[]) => {
    const findings = candidates.filter((f) => f.evidence.length && f.evidence.every((e) => store.get(e)) && canPublish(f));
    if (findings.length) sections.push({ id, title, findings });
  };
  const fact = (finding: string, soWhat: string, evidence: string[]): Finding => ({ finding, soWhat, evidence: [...new Set(evidence)], basis: 'observed', check: 'supported' });
  const { keywords, ads, social, competitors } = insights;
  // Cite the actual phrase, not a cluster label that could imply a location.
  add('demand', 'Search suggestions', keywords.topKeywords.slice(0, 3).map((k) => fact(
    `Autocomplete returned "${k.phrase}" from ${k.engines.join(', ') || 'an unspecified engine'}.`,
    'This is a suggestion, not a count of searches or proof of local buyers. Validate country-specific volume and intent before investing.', k.evidenceIds)));
  add('ads', 'Advertising observations', ads.winners.slice(0, 3).map((a) => fact(
    `${a.advertiser}: ${Number.isFinite(a.daysRunning) ? `${Math.round(a.daysRunning)} days between the recorded ad dates` : 'ad dates unavailable'}. Current activity: ${a.active === null ? 'not confirmed' : a.active ? 'reported active by the source' : 'reported inactive by the source'}.`,
    'Use this creative as a test reference. The date span does not establish continuous spend, sales or profitability.', [a.id])));
  add('organic', 'Content observations', Object.values(social.topByPlatform).flat().filter((p) => Number.isFinite(p.outlier)).slice(0, 3).map((p) => fact(
    `${p.source} content by ${p.author || 'an unnamed creator'} recorded ${p.outlier.toFixed(1)} times the median engagement measure in its ${p.baseline}.`,
    'The comparison covers collected posts only. Test the format with your own audience; it does not prove buyer demand, sales or causation.', [p.id])));
  add('competitors', 'Retailer observations', competitors.flatMap((s) => [...(s.retail ?? [])].sort((a, b) => Number(/\/InStock$/.test(b.availability)) - Number(/\/InStock$/.test(a.availability))).slice(0, 1).map((p) => fact(
    `${s.host} lists "${p.name}" at ${p.price} ${p.currency || '(currency not stated)'} (${p.priceBasis || 'listed offer'}). Listed stock: ${p.availability?.split('/').pop() || 'not confirmed'}.`,
    'This is one dated product listing. Compare equivalent garments and variants, then check the live price, stock and service conditions.', [p.evidenceId]))).slice(0, 3));
  // When product prices were not collected, describe crawl coverage rather than invent a market price.
  if (!sections.some((s) => s.id === 'competitors')) add('competitors', 'Website coverage', competitors.slice(0, 3).map((s) => fact(
    `${s.host}: ${s.pages.length} readable pages were collected for this audit.`,
    'Inspect the linked pages. This limited crawl cannot establish the full catalogue, all policies or missing competitor content.', s.pages.slice(0, 3).map((p) => p.evidenceId))));
  add('audience', 'Potential customer feedback', social.voc.flatMap((t) => t.quotes).filter((q) => store.get(q.evidenceId)?.text.includes(q.quote)).slice(0, 3).map((q) => fact(
    `One collected customer-source item says: "${q.quote}"`,
    'This is one public statement. Buyer identity was not independently verified; it is not a representative buyer survey. Verify the source and interview independent buyers before generalising.', [q.evidenceId])));
  return sections;
}

export async function synthesize(brief: Brief, insights: Insights, coverage: TaskResult[], store: EvidenceStore, _meter: CostMeter): Promise<Omit<Report, 'cost'>> {
  insights = publicInsights(insights, store, brief);
  const sections = measuredSections(insights, store);
  const executiveSummary = sections.map((s) => s.findings[0]).slice(0, 5).map((f) => ({ ...f, action: 'Choose a suggested test below and measure the result.' }));
  const caveats = [
    'Autocomplete suggestions are observed phrases, not measured demand. Monthly search volume, ranking difficulty and market size were not measured.',
    'Ad date spans and variants do not show profit, conversions, continuous spend or return on ad spend.',
    'Items with unknown geography are not confirmed local demand. Source relevance checks use category and identity rules and may require manual review.',
    'A limited website crawl cannot prove that competitors lack a product, page, policy or reviews. Sitemap URL counts are not product counts.',
    'Creator captions and seller copy are content inspiration, not independent customer research. Suggested audience and intent labels are interpretations; check the source.',
    'Tracking pixels show installed technology, not current advertising activity.',
    'Shipping, stock and offer information is a dated snapshot; check the linked page before acting.',
    ...coverage.filter((r) => !r.ok || !r.count).map((r) => `${r.task.source}: ${r.note || 'No public results returned.'}`),
  ];
  if (!insights.social.voc.length) caveats.unshift('No independent customer quotations were collected. Buyer preferences and willingness to pay remain unvalidated.');
  if (!sections.length) caveats.unshift('No findings with valid source records are available. This is a limited report.');
  return { brief, generatedAt: new Date().toISOString(), headline: `Research findings for ${brief.brand || brief.niche || brief.product}`, executiveSummary, sections, recommendations: buildRecommendations(insights), caveats, insights, coverage, marketingPlan: buildMarketingPlan(brief, reviewEvidence(store.all(), brief).evidence) };
}

/** Concrete experiments, consistently framed as hypotheses rather than promises. */
export function buildRecommendations(insights: Insights): Recommendation[] {
  const out: Recommendation[] = [];
  const add = (action: string, channel: string, hypothesis: string, evidence: string[]) => out.push({ action, channel, hypothesis, evidence });
  for (const keyword of insights.keywords.topKeywords.filter((c) => c.intent === 'transactional' || c.intent === 'commercial').slice(0, 3)) {
    add(`Validate searches for "${keyword.phrase}", then test one relevant product or landing page.`, 'Website & search', 'Check country-specific search volume and intent first. Measure qualified visits, enquiries and orders against the existing page. Advertise only services and locations you actually provide.', keyword.evidenceIds.slice(0, 3));
  }
  if (insights.competitors.length) add('Compare a small set of equivalent products and clarify your sizing, delivery and returns.', 'Website', 'Record garment, currency, stock, included accessories and service conditions separately. Test whether clearer information improves enquiries or checkout completion.', insights.competitors.flatMap((s) => s.pages.filter((p) => p.type === 'product').map((p) => p.evidenceId)).slice(0, 4));
  if (insights.social.posts) add('Test a product demonstration against an occasion-focused video.', 'Social content', 'Use the same audience and comparable distribution. Measure qualified clicks and enquiries; engagement alone does not establish sales.', Object.values(insights.social.topByPlatform).flat().slice(0, 3).map((p) => p.id));
  if (insights.ads.total) add('Test two relevant ad concepts with a small, defined budget.', 'Paid advertising', 'Set a maximum acceptable cost per order using your actual margin. Compare conversions before choosing a concept; competitor ad longevity does not predict results.', insights.ads.winners.filter((a) => a.text || a.headline).slice(0, 3).map((a) => a.id));
  add('Collect independent feedback from actual buyers before committing to a positioning claim.', 'Customer research', 'Ask about fit, buying occasion, delivery and alternatives. Report how many independent buyers were interviewed and keep seller/creator opinions separate.', []);
  return out;
}
