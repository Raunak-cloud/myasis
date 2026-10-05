import type { Brief, Evidence } from '../core/types.js';
import { sameWebsite } from '../core/quality.js';
import { seoIssues } from '../insights/competitors.js';

export interface MarketingPlan {
  evidenceWindow: { first: string; last: string } | null;
  auditActions: Array<{ priority: 'Check first' | 'Review'; owner: 'Your site' | 'Comparison site'; issue: string; action: string; url: string; evidenceId: string; collectedAt: string }>;
  roadmap: Array<{ week: number; action: string; measure: string; evidence: string[] }>;
}

/** A useful plan without invented forecasts, market scores or ranking promises. */
export function buildMarketingPlan(brief: Brief, items: Evidence[]): MarketingPlan {
  const dates = items.map((p) => p.collectedAt).sort();
  const pages = items.filter((p) => p.source === 'website' && p.attributes.pageType !== 'sitemap');
  const own = pages.filter((p) => brief.ownWebsite && sameWebsite(p.url, brief.ownWebsite));
  const auditActions = (brief.ownWebsite ? own : pages).flatMap((p) => seoIssues(p).map((issue): MarketingPlan['auditActions'][number] => ({
    priority: /noindex|missing <title>/.test(issue) ? 'Check first' : 'Review',
    owner: brief.ownWebsite ? 'Your site' : 'Comparison site', issue,
    action: /noindex/.test(issue) ? 'Confirm whether this page should appear in search before changing its indexing rule.' : /title>/.test(issue) ? 'Add a descriptive title for this page.' : /description/.test(issue) ? 'Write a useful page summary; Google may choose a different search snippet.' : /canonical/.test(issue) ? 'Review duplicate URLs and select a canonical where appropriate.' : /alt text/.test(issue) ? 'Describe informative images; decorative images can use empty alt text.' : 'Check that the visible main heading clearly describes this page.',
    url: p.url, evidenceId: p.id, collectedAt: p.collectedAt,
  }))).sort((a, b) => Number(b.priority === 'Check first') - Number(a.priority === 'Check first')).slice(0, 20);
  const keyword = items.find((p) => p.source === 'autocomplete' && p.text && /\b(buy|shop|price|best|how|what|where|size)\b/i.test(p.text)) ?? items.find((p) => p.source === 'autocomplete' && p.text);
  const ad = items.find((p) => p.kind === 'ad' && p.text);
  return {
    evidenceWindow: dates.length ? { first: dates[0], last: dates.at(-1)! } : null,
    auditActions,
    roadmap: [
      { week: 1, action: own.length ? 'Review the page checks below and clarify your product, delivery and returns information.' : 'Review your product information and interview independent buyers about their needs.', measure: 'Record changes and baseline enquiries, orders and conversion rate from your own analytics. Add your website to receive page-specific checks.', evidence: own.slice(0, 3).map((p) => p.id) },
      { week: 2, action: keyword ? `Validate the suggestion "${keyword.text}" in ${brief.country}, then draft one useful page answering that need.` : 'Collect country-specific keyword evidence before choosing a search topic.', measure: 'Check search intent and country-specific volume with a keyword provider. After publishing, track Search Console impressions and qualified visits; no volume is available in this report.', evidence: keyword ? [keyword.id] : [] },
      { week: 3, action: 'Test a product demonstration against an occasion or use-case video.', measure: 'Keep audience and distribution comparable. Compare qualified clicks and enquiries using tagged links; likes alone do not measure sales.', evidence: [] },
      { week: 4, action: ad ? 'Use the linked ad as inspiration for two truthful concepts, then run a small capped test if it fits your budget.' : 'Review your measured results before deciding whether to run a small capped advertising test.', measure: 'Set the spend cap and acceptable acquisition cost from your actual margin. Compare attributed orders and costs; competitor spend and ROAS are unavailable.', evidence: ad ? [ad.id] : [] },
    ],
  };
}
