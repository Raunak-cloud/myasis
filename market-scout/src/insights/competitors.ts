import type { Evidence } from '../core/types.js';
import type { CostMeter } from '../llm/celeris.js';
import { sameWebsite } from '../core/quality.js';

/**
 * Each audited site: positioning and pricing (read by Magnus from the pages
 * that state them), on-page SEO issues (measured, not judged), the marketing
 * stack and installed tracking (which does not prove active campaigns).
 */

export interface SiteProfile {
  host: string;
  pages: Array<{ type: string; url: string; title: string; evidenceId: string }>;
  positioning: {
    valueProposition: string;
    audience: string;
    category: string;
    differentiators: string[];
    pricingModel: string;
    priceTiers: Array<{ name: string; price: string; period: string }>;
    freeTrial: string;
    offers: string[];
    guarantees: string[];
    proof: string[];
    primaryCta: string;
  } | null;
  seoIssues: Array<{ url: string; issue: string }>;
  pixels: string[];
  stack: string[];
  contentSections: string[];
  contentTopics: number;
  retail?: Array<{ name: string; price: string; currency: string; availability: string; url: string; evidenceId: string; priceBasis?: string }>;
  serviceTerms?: Array<{ type: string; text: string; url: string; evidenceId: string }>;
}

/** Plain rules from the usual on-page checklist. Each issue names the page it was measured on. */
export function seoIssues(page: Evidence): string[] {
  const m = page.metrics;
  const a = page.attributes;
  const issues: string[] = [];
  if (!page.title) issues.push('missing <title>');
  if (!a.metaDescription) issues.push('no meta description');
  if (m.h1Count === 0) issues.push('no H1');
  if (!a.canonical) issues.push('no canonical link');
  if (m.imagesWithoutAlt > 0) issues.push(`${m.imagesWithoutAlt} images without alt text; review informative images`);
  if (/noindex/i.test(String(a.robotsMeta ?? ''))) issues.push('page is set to noindex; confirm whether exclusion is intentional');
  return issues;
}

/** Only numeric, same-site, explicitly structured listings become price facts. */
export function retailListings(page: Evidence): NonNullable<SiteProfile['retail']> {
  try {
    const products: unknown = JSON.parse(String(page.attributes.products ?? '[]'));
    if (!Array.isArray(products)) return [];
    return products.flatMap((p) => {
      if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.price !== 'string' || !/^\d+(?:\.\d+)?$/.test(p.price.trim()) || !Number.isFinite(Number(p.price))) return [];
      const currency = typeof p.currency === 'string' ? p.currency.toUpperCase().trim() : '';
      if (currency && !/^[A-Z]{3}$/.test(currency)) return [];
      let url: URL;
      try { url = new URL(String(p.url || page.url), page.url); } catch { return []; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !sameWebsite(url.href, page.url)) return [];
      const availability = typeof p.availability === 'string' && /^https?:\/\/schema.org\/(InStock|OutOfStock|PreOrder|PreSale|BackOrder|LimitedAvailability|Discontinued|SoldOut|OnlineOnly|InStoreOnly)$/.test(p.availability) ? p.availability : '';
      return [{ name: p.name.trim(), price: p.price.trim(), currency, availability, url: url.href, evidenceId: page.id, priceBasis: ['lowest listed price', 'listed offer'].includes(p.priceBasis) ? p.priceBasis : 'price basis not recorded' }];
    });
  } catch { return []; }
}

export function siteProfiles(all: Evidence[]): SiteProfile[] {
  const pages = all.filter((item) => item.source === 'website');
  return [...new Set(pages.map((p) => p.author))].map((host) => {
    const own = pages.filter((p) => p.author === host);
    const content = own.filter((p) => p.attributes.pageType !== 'sitemap');
    const sitemap = own.find((p) => p.attributes.pageType === 'sitemap');
    const union = (key: string) => [...new Set(content.flatMap((p) => Array.isArray(p.attributes[key]) ? p.attributes[key] as string[] : []))];
    return {
      host,
      pages: content.map((p) => ({ type: String(p.attributes.pageType), url: p.url, title: p.title, evidenceId: p.id })),
      positioning: null,
      seoIssues: content.flatMap((p) => seoIssues(p).map((issue) => ({ url: p.url, issue }))),
      pixels: union('pixels'), stack: [...union('platform'), ...union('analytics'), ...union('marketingTools')],
      contentSections: Array.isArray(sitemap?.attributes.sections) ? sitemap.attributes.sections : [],
      contentTopics: Array.isArray(sitemap?.attributes.topics) ? sitemap.attributes.topics.length : 0,
      retail: content.flatMap(retailListings).filter((p, i, a) => a.findIndex((o) => o.name === p.name && o.price === p.price && o.url === p.url) === i).slice(0, 50),
      serviceTerms: content.filter((p) => ['shipping', 'returns', 'sizing', 'product'].includes(String(p.attributes.pageType))).map((p) => ({ type: p.attributes.pageType === 'product' ? 'Product details' : String(p.attributes.pageType), text: p.attributes.pageType === 'product' ? String(p.attributes.commerceText || p.text) : p.text, url: p.url, evidenceId: p.id })),
    };
  }).filter((s) => s.pages.length);
}

export async function analyzeCompetitors(all: Evidence[], _meter: CostMeter): Promise<SiteProfile[]> {
  return siteProfiles(all);
}
