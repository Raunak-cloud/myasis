import type { Evidence } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit, UNTRUSTED } from '../llm/extract.js';

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
  retail?: Array<{ name: string; price: string; currency: string; availability: string; url: string; evidenceId: string }>;
  serviceTerms?: Array<{ type: string; text: string; url: string; evidenceId: string }>;
}

/** Plain rules from the usual on-page checklist. Each issue names the page it was measured on. */
export function seoIssues(page: Evidence): string[] {
  const m = page.metrics;
  const a = page.attributes;
  const issues: string[] = [];
  if (!page.title) issues.push('missing <title>');
  else if (m.titleLength > 65) issues.push(`title is ${m.titleLength} characters (over ~60 gets truncated)`);
  else if (m.titleLength < 25) issues.push(`title is only ${m.titleLength} characters`);
  if (!a.metaDescription) issues.push('no meta description');
  else if (m.metaDescriptionLength > 165) issues.push(`meta description is ${m.metaDescriptionLength} characters (over ~160 gets truncated)`);
  if (m.h1Count === 0) issues.push('no H1');
  else if (m.h1Count > 1) issues.push(`${m.h1Count} H1s`);
  if (!a.canonical) issues.push('no canonical link');
  if (!(a.schema as string[] | undefined)?.length) issues.push('no structured data (JSON-LD)');
  if (m.imagesWithoutAlt >= 5) issues.push(`${m.imagesWithoutAlt} images without alt text`);
  if (/noindex/i.test(String(a.robotsMeta ?? ''))) issues.push('page is set to noindex');
  if (m.wordCount < 250 && a.pageType !== 'pricing') issues.push(`thin content (${m.wordCount} words)`);
  return issues;
}

export async function analyzeCompetitors(all: Evidence[], meter: CostMeter): Promise<SiteProfile[]> {
  const pages = all.filter((item) => item.source === 'website');
  const hosts = [...new Set(pages.map((page) => page.author))];

  return mapLimit(hosts, 3, async (host): Promise<SiteProfile> => {
    const own = pages.filter((page) => page.author === host);
    const content = own.filter((page) => page.attributes.pageType !== 'sitemap');
    const sitemap = own.find((page) => page.attributes.pageType === 'sitemap');
    const union = (key: string) => [...new Set(content.flatMap((page) => (page.attributes[key] as string[] | undefined) ?? []))];

    let positioning: SiteProfile['positioning'] = null;
    if (content.length) {
      const order = ['home', 'pricing', 'product', 'compare', 'customers', 'about', 'shop'];
      const text = [...content]
        .sort((a, b) => order.indexOf(String(a.attributes.pageType)) - order.indexOf(String(b.attributes.pageType)))
        .map((page) => `## ${String(page.attributes.pageType).toUpperCase()} PAGE — ${page.url}\nCTAs: ${((page.attributes.ctas as string[]) ?? []).join(' | ')}\nExact commerce text: ${String(page.attributes.commerceText ?? '').slice(0, 2_000)}\n${page.text.slice(0, 4_000)}`)
        .join('\n\n')
        .slice(0, 22_000);
      try {
        positioning = await askJson<NonNullable<SiteProfile['positioning']>>({
          model: 'celeris-1-magnus',
          system: `You are a product-marketing analyst reverse-engineering a company's positioning from its own website. ${UNTRUSTED}`,
          prompt: `Site: ${host}\n\nDescribe its positioning using only what these pages state: value proposition, audience, category, differentiators, pricing model, explicitly named tiers, offers, guarantees, seller-stated proof and primary CTA. For retailers do not invent SaaS tiers or use a mixed jewellery/accessory/clothing price range. Keep shipping thresholds, exclusions, refund fees, dates and other conditions. A listed price does not prove purchases or willingness to pay. Use "" or [] for anything the pages do not state.\n\n${text}`,
          schema: {
            type: 'object',
            properties: {
              valueProposition: { type: 'string' },
              audience: { type: 'string' },
              category: { type: 'string' },
              differentiators: { type: 'array', items: { type: 'string' } },
              pricingModel: { type: 'string' },
              priceTiers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' }, period: { type: 'string' } } } },
              freeTrial: { type: 'string' },
              offers: { type: 'array', items: { type: 'string' } },
              guarantees: { type: 'array', items: { type: 'string' } },
              proof: { type: 'array', items: { type: 'string' } },
              primaryCta: { type: 'string' },
            },
          },
          meter,
          effort: 'low',
          maxTokens: 3_000,
        });
      } catch {
        positioning = null;
      }
    }

    const retail: NonNullable<SiteProfile['retail']> = [];
    for (const page of content) {
      try {
        const products = JSON.parse(String(page.attributes.products ?? '[]'));
        if (Array.isArray(products)) for (const p of products) if (p && typeof p.name === 'string' && typeof p.price === 'string') retail.push({ name: p.name, price: p.price, currency: String(p.currency ?? ''), availability: String(p.availability ?? ''), url: String(p.url || page.url), evidenceId: page.id });
      } catch { /* no structured product data; do not invent it */ }
    }
    return {
      host,
      pages: content.map((page) => ({ type: String(page.attributes.pageType), url: page.url, title: page.title, evidenceId: page.id })),
      positioning,
      seoIssues: content.flatMap((page) => seoIssues(page).map((issue) => ({ url: page.url, issue }))),
      pixels: union('pixels'),
      stack: [...union('platform'), ...union('analytics'), ...union('marketingTools')],
      contentSections: (sitemap?.attributes.sections as string[] | undefined) ?? [],
      contentTopics: ((sitemap?.attributes.topics as string[] | undefined) ?? []).length,
      retail: retail.filter((p, i, a) => a.findIndex((o) => o.name === p.name && o.price === p.price && o.url === p.url) === i).slice(0, 50),
      serviceTerms: content.filter((p) => ['shipping', 'returns', 'sizing', 'product'].includes(String(p.attributes.pageType))).map((p) => ({ type: p.attributes.pageType === 'product' ? 'Product details' : String(p.attributes.pageType), text: p.attributes.pageType === 'product' ? String(p.attributes.commerceText || p.text) : p.text, url: p.url, evidenceId: p.id })),
    };
  });
}
