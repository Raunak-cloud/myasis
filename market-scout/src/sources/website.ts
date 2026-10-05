import { gunzipSync } from 'node:zlib';
import { distill, type PageFacts } from '../browser/distill.js';
import { visit, withPage } from '../browser/session.js';
import { BlockedError, disallowReason, fetchText, http, politely, robotsAllows, robotsFor } from '../core/politeness.js';
import { evidence } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { UNTRUSTED } from '../llm/extract.js';
import type { Source } from './source.js';

/**
 * A competitor's (or your own) website: the sitemap as a content inventory,
 * then the pages that carry positioning — home, pricing, product, compare,
 * customers — read in a real browser so client-rendered sites work.
 *
 * This is the one true crawler, so robots.txt governs every URL it opens.
 */

/** Script hosts and inline markers → the tool behind them. Ad pixels show which channels a competitor buys. */
const FINGERPRINTS: Array<{ name: string; kind: 'pixel' | 'analytics' | 'platform' | 'marketing' | 'support'; pattern: RegExp }> = [
  { name: 'Meta Pixel', kind: 'pixel', pattern: /connect\.facebook\.net|fbq\(/i },
  { name: 'TikTok Pixel', kind: 'pixel', pattern: /analytics\.tiktok\.com|ttq\.load/i },
  { name: 'Google Ads', kind: 'pixel', pattern: /googleadservices|gtag\(['"]config['"],\s*['"]AW-/i },
  { name: 'Reddit Pixel', kind: 'pixel', pattern: /redditstatic\.com\/ads|rdt\(['"]init/i },
  { name: 'LinkedIn Insight', kind: 'pixel', pattern: /snap\.licdn\.com|_linkedin_partner_id/i },
  { name: 'Pinterest Tag', kind: 'pixel', pattern: /s\.pinimg\.com\/ct|pintrk\(/i },
  { name: 'Snap Pixel', kind: 'pixel', pattern: /sc-static\.net|snaptr\(/i },
  { name: 'X Pixel', kind: 'pixel', pattern: /static\.ads-twitter\.com|twq\(/i },
  { name: 'Microsoft Ads', kind: 'pixel', pattern: /bat\.bing\.com/i },
  { name: 'Google Analytics 4', kind: 'analytics', pattern: /googletagmanager\.com\/gtag|gtag\(['"]config['"],\s*['"]G-/i },
  { name: 'Google Tag Manager', kind: 'analytics', pattern: /googletagmanager\.com\/gtm|GTM-[A-Z0-9]+/i },
  { name: 'Hotjar', kind: 'analytics', pattern: /hotjar/i },
  { name: 'Microsoft Clarity', kind: 'analytics', pattern: /clarity\.ms/i },
  { name: 'Segment', kind: 'analytics', pattern: /cdn\.segment\.com/i },
  { name: 'Mixpanel', kind: 'analytics', pattern: /mixpanel/i },
  { name: 'Shopify', kind: 'platform', pattern: /cdn\.shopify\.com|shopify/i },
  { name: 'WordPress', kind: 'platform', pattern: /wp-content|wordpress/i },
  { name: 'Webflow', kind: 'platform', pattern: /webflow/i },
  { name: 'Wix', kind: 'platform', pattern: /wixstatic|parastorage/i },
  { name: 'Squarespace', kind: 'platform', pattern: /squarespace/i },
  { name: 'Next.js', kind: 'platform', pattern: /\/_next\//i },
  { name: 'HubSpot', kind: 'marketing', pattern: /hs-scripts|hubspot|hsforms/i },
  { name: 'Klaviyo', kind: 'marketing', pattern: /klaviyo/i },
  { name: 'Mailchimp', kind: 'marketing', pattern: /chimpstatic|mailchimp/i },
  { name: 'Marketo', kind: 'marketing', pattern: /marketo|mktoforms/i },
  { name: 'Intercom', kind: 'support', pattern: /intercom/i },
  { name: 'Drift', kind: 'support', pattern: /drift\.com|js\.driftt/i },
  { name: 'Zendesk', kind: 'support', pattern: /zdassets|zendesk/i },
  { name: 'Stripe', kind: 'platform', pattern: /js\.stripe\.com/i },
];

export function detectStack(facts: Pick<PageFacts, 'scriptSources' | 'inlineSignals' | 'generator'>): Record<string, string[]> {
  const haystack = [...facts.scriptSources, ...facts.inlineSignals, facts.generator].join(' ');
  const found: Record<string, string[]> = {};
  for (const print of FINGERPRINTS) {
    if (print.pattern.test(haystack)) (found[print.kind] ??= []).push(print.name);
  }
  return found;
}

/** Which pages say the most about positioning, best first. */
const KEY_PAGES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'pricing', pattern: /pric|plans|subscribe/i },
  { label: 'product', pattern: /product|features|platform|how-it-works|solutions?/i },
  { label: 'compare', pattern: /compare|\bvs\b|-vs-|alternative/i },
  { label: 'customers', pattern: /customers|case-stud|testimonial|reviews|success/i },
  { label: 'about', pattern: /about|our-story|company/i },
  { label: 'shop', pattern: /shop|collections|best-?sellers|catalog/i },
];

/**
 * Positioning lives on shallow, navigational pages (/pricing, /features), not
 * in articles: blog posts whose slugs happen to say "price" or "vs" are
 * excluded, and of several matches the shallowest wins.
 */
export function pickKeyPages(links: Array<{ text: string; href: string }>, limit: number): Array<{ label: string; url: string }> {
  const candidates = links
    .map((link) => ({ ...link, path: new URL(link.href).pathname.replace(/\/+$/, '') }))
    .filter((link) => link.path && !/\/(blog|news|articles?|posts?|stories|learn|resources|guides?|recipes?)\//i.test(`${link.path}/`) && link.path.split('/').length <= 3);
  const chosen: Array<{ label: string; url: string }> = [];
  for (const { label, pattern } of KEY_PAGES) {
    const match = candidates
      .filter((link) => (pattern.test(link.path) || pattern.test(link.text)) && !chosen.some((c) => c.url === link.href))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length)[0];
    if (match) chosen.push({ label, url: match.href });
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/**
 * The model reads the homepage's links the way an analyst would and picks the
 * pages that state positioning. Slug rules alone confuse "creatine-priceline-
 * alternatives" with a pricing page; the rules remain as the fallback.
 */
async function chooseKeyPages(
  homeLinks: Array<{ text: string; href: string }>,
  allLinks: Array<{ text: string; href: string }>,
  limit: number,
  meter: CostMeter,
): Promise<Array<{ label: string; url: string }>> {
  if (limit <= 0) return [];
  const menu = homeLinks.slice(0, 250);
  try {
    const reply = await askJson<{ pages: Array<{ index: number; label: string }> }>({
      model: 'celeris-1',
      system: `You pick which pages of a company's website best reveal its positioning, pricing and offers. ${UNTRUSTED}`,
      prompt: `Choose up to ${limit} links, most useful first, one per kind: pricing/plans, product or features (or best-sellers for a shop), comparison or alternatives pages the company wrote, customers/reviews/case studies, about. Skip blog articles, legal pages, login, careers and single minor products.\n\n${menu.map((link, index) => `[${index}] ${link.text || '(no text)'} — ${new URL(link.href).pathname}`).join('\n')}`,
      schema: {
        type: 'object',
        properties: {
          pages: {
            type: 'array',
            items: { type: 'object', properties: { index: { type: 'integer' }, label: { type: 'string', enum: ['pricing', 'product', 'compare', 'customers', 'about', 'shop'] } } },
          },
        },
      },
      meter,
      maxTokens: 600,
    });
    const picked = (reply.pages ?? [])
      .map((page) => ({ label: page.label, url: menu[page.index]?.href ?? '' }))
      .filter((page, index, all) => page.url && all.findIndex((other) => other.url === page.url) === index)
      .slice(0, limit);
    if (picked.length) return picked;
  } catch {
    // Fall back to slug rules below.
  }
  return pickKeyPages(allLinks, limit);
}

async function sitemapUrls(origin: string, cap = 2_000): Promise<string[]> {
  const robots = await robotsFor(origin);
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls = new Set<string>();
  const seen = new Set<string>();
  while (queue.length && urls.size < cap && seen.size < 12) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      let xml: string;
      if (next.endsWith('.gz')) {
        const response = await http(next, { api: true });
        if (!response.ok) continue;
        xml = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
      } else {
        const response = await politely(next, () => fetchText(next));
        if (response.status !== 200) continue;
        xml = response.body;
      }
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((match) => match[1].trim());
      if (/<sitemapindex/i.test(xml)) queue.push(...locs.slice(0, 20));
      else for (const loc of locs) if (urls.size < cap) urls.add(loc);
    } catch {
      // A missing or malformed sitemap leaves the inventory empty, nothing more.
    }
  }
  return [...urls];
}

/** URL inventory → sections with counts, and the slugs as readable topics. */
export function inventory(urls: string[]): { sections: Record<string, number>; topics: string[] } {
  const sections: Record<string, number> = {};
  const topics: string[] = [];
  for (const raw of urls) {
    let path: string;
    try {
      path = new URL(raw).pathname;
    } catch {
      continue;
    }
    const parts = path.split('/').filter(Boolean);
    const section = parts.length > 1 ? parts[0] : '(root)';
    sections[section] = (sections[section] ?? 0) + 1;
    const slug = parts.at(-1);
    if (slug && parts.length > 1) topics.push(decodeURIComponent(slug).replace(/\.\w+$/, '').replace(/[-_]+/g, ' '));
  }
  return { sections, topics: topics.slice(0, 400) };
}

function pageEvidence(facts: PageFacts, label: string, query: string): Evidence {
  const stack = detectStack(facts);
  return evidence({
    source: 'website',
    kind: 'page',
    key: facts.url.replace(/[?#].*$/, ''),
    url: facts.url,
    title: facts.title,
    text: facts.markdown.slice(0, 10_000),
    author: new URL(facts.url).host,
    metrics: {
      wordCount: facts.wordCount,
      titleLength: facts.title.length,
      metaDescriptionLength: facts.metaDescription.length,
      h1Count: facts.h1.length,
      imagesWithoutAlt: facts.imagesWithoutAlt,
      internalLinks: facts.internalLinks,
      externalLinks: facts.externalLinks,
      hreflang: facts.hreflangCount,
    },
    attributes: {
      pageType: label,
      metaDescription: facts.metaDescription,
      canonical: facts.canonical,
      robotsMeta: facts.robotsMeta,
      h1: facts.h1,
      outline: facts.outline,
      schema: facts.jsonLdTypes,
      ctas: facts.aboveFoldCtas,
      ogTitle: facts.openGraph['og:title'] ?? '',
      pixels: stack.pixel ?? [],
      analytics: stack.analytics ?? [],
      platform: stack.platform ?? [],
      marketingTools: [...(stack.marketing ?? []), ...(stack.support ?? [])],
    },
    query,
  });
}

export const website: Source = {
  id: 'website',
  label: 'Websites (competitor and own sites)',
  describe: 'A site\'s positioning, pricing, offers, CTAs, on-page SEO (titles, metas, H1s, schema), content inventory from its sitemap, and its marketing stack including which ad pixels it runs.',
  queryHint: 'The site\'s homepage URL or domain (e.g. "https://www.competitor.com").',
  defaultLimit: 7,
  unavailable: () => '',
  async run(task, ctx) {
    const start = new URL(/^https?:\/\//.test(task.query.trim()) ? task.query.trim() : `https://${task.query.trim()}`);
    const out: Evidence[] = [];

    const urls = await sitemapUrls(start.origin);
    if (urls.length) {
      const { sections, topics } = inventory(urls);
      out.push(
        evidence({
          source: 'website',
          kind: 'page',
          key: `${start.origin}/#sitemap`,
          url: `${start.origin}/sitemap.xml`,
          title: `${start.host} content inventory`,
          text: `Sitemap of ${start.host}: ${urls.length} URLs.\nSections: ${Object.entries(sections).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} (${count})`).join(', ')}\nTopics: ${topics.slice(0, 200).join('; ')}`,
          author: start.host,
          metrics: { urls: urls.length },
          attributes: { pageType: 'sitemap', sections: Object.keys(sections), topics },
          query: task.query,
        }),
      );
    }

    await withPage(async (page) => {
      if (!(await robotsAllows(start.toString()))) throw new BlockedError(start.host, await disallowReason(start.toString()));
      await visit(page, start.toString());
      const home = await distill(page, 15_000);
      out.push(pageEvidence(home, 'home', task.query));
      const internal = [...home.links, ...urls.map((href) => ({ text: '', href }))].filter((link) => {
        try {
          return new URL(link.href).host === new URL(home.url).host;
        } catch {
          return false;
        }
      });
      for (const target of await chooseKeyPages(home.links.filter((link) => internal.includes(link)), internal, Math.max(0, task.limit - 1), ctx.meter)) {
        if (!(await robotsAllows(target.url))) continue;
        try {
          await visit(page, target.url);
          out.push(pageEvidence(await distill(page, 15_000), target.label, task.query));
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          ctx.log(`  skipped ${target.url}: ${(error as Error).message.split('\n')[0]}`);
        }
      }
    });
    return out;
  },
};
