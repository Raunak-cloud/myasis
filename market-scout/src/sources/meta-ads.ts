import { config } from '../config.js';
import { pick, pickNumber, pickString, toIsoDate } from '../core/harvest.js';
import { httpJson } from '../core/politeness.js';
import { evidence } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import { withPage } from '../browser/session.js';
import { browseAndExtract, type BrowseSpec, type Source } from './source.js';

/**
 * Facebook and Instagram ads from Meta's Ad Library.
 *
 * Two routes, chosen by what Meta actually serves:
 *  - The Graph API `ads_archive` returns commercial ads only for ads reached
 *    in the EU/UK (DSA), with EU reach. Used when a token is set and the
 *    brief's country is in that set.
 *  - Everywhere else, the public library page, logged out. Its results
 *    arrive as GraphQL JSON, read straight from the network.
 *
 * The library shows no spend for commercial ads, so "performing" is inferred
 * downstream from how long an ad has run and how many variants it has.
 */

const DSA_COUNTRIES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'UK', 'IS', 'LI', 'NO']);
const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v23.0';
const DAY = 86_400_000;

function daysBetween(startIso: string, endIso: string): number {
  if (!startIso) return Number.NaN;
  const end = endIso ? Date.parse(endIso) : Date.now();
  return Math.max(1, Math.round((Math.min(end, Date.now()) - Date.parse(startIso)) / DAY));
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function libraryUrl(id: string): string {
  return `https://www.facebook.com/ads/library/?id=${id}`;
}

/** One ad as the library's GraphQL describes it. */
function fromGraphql(node: Record<string, unknown>, query: string): Evidence | undefined {
  const id = pickString(node, 'ad_archive_id', 'adArchiveID');
  if (!id) return undefined;
  const snapshot = (pick(node, 'snapshot') ?? {}) as Record<string, unknown>;
  const startedAt = toIsoDate(pick(node, 'start_date', 'startDate'));
  const active = pick(node, 'is_active', 'isActive') !== false;
  const endedAt = active ? '' : toIsoDate(pick(node, 'end_date', 'endDate'));
  const body = pickString(snapshot, 'body.text', 'cards.0.body', 'body');
  const platforms = (pick(node, 'publisher_platform', 'publisherPlatform') as string[] | undefined) ?? [];
  const media = [
    pickString(snapshot, 'videos.0.video_preview_image_url', 'cards.0.video_preview_image_url'),
    pickString(snapshot, 'images.0.original_image_url', 'images.0.resized_image_url', 'cards.0.original_image_url'),
  ].filter(Boolean);
  return evidence({
    source: 'meta-ads',
    kind: 'ad',
    key: id,
    url: libraryUrl(id),
    title: pickString(snapshot, 'title', 'cards.0.title', 'link_description'),
    text: body,
    author: pickString(node, 'page_name', 'snapshot.page_name') || pickString(snapshot, 'page_name'),
    publishedAt: startedAt,
    metrics: {
      daysRunning: daysBetween(startedAt, endedAt),
      variants: pickNumber(node, 'collation_count') || 1,
      platforms: platforms.length || 1,
      active: active ? 1 : 0,
      pageLikes: pickNumber(snapshot, 'page_like_count'),
      euReach: pickNumber(node, 'reach_estimate', 'eu_total_reach'),
    },
    attributes: {
      cta: pickString(snapshot, 'cta_text', 'cards.0.cta_text'),
      ctaType: pickString(snapshot, 'cta_type'),
      landingUrl: pickString(snapshot, 'link_url', 'cards.0.link_url'),
      caption: pickString(snapshot, 'caption'),
      format: pickString(snapshot, 'display_format'),
      platforms: platforms.map(String),
      collationId: pickString(node, 'collation_id'),
      pageId: pickString(node, 'page_id', 'snapshot.page_id'),
      media,
    },
    query,
  });
}

async function viaApi(query: string, country: string, limit: number): Promise<Evidence[]> {
  const fields = 'id,page_id,page_name,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,ad_creative_link_descriptions,ad_snapshot_url,publisher_platforms,eu_total_reach,languages';
  const params = new URLSearchParams({
    search_terms: query,
    ad_reached_countries: JSON.stringify([country === 'UK' ? 'GB' : country]),
    ad_type: 'ALL',
    ad_active_status: 'ALL',
    fields,
    limit: '100',
    access_token: config.apis.metaAccessToken,
  });
  let next: string | undefined = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${params}`;
  const out: Evidence[] = [];
  while (next && out.length < limit) {
    const page: { data?: Array<Record<string, unknown>>; paging?: { next?: string } } = await httpJson(next, { api: true, minGapMs: 18_000 }); // ~200 calls/hour
    for (const ad of page.data ?? []) {
      const id = String(ad.id);
      const startedAt = toIsoDate(ad.ad_delivery_start_time);
      const endedAt = toIsoDate(ad.ad_delivery_stop_time);
      const bodies = (ad.ad_creative_bodies as string[] | undefined) ?? [];
      const platforms = (ad.publisher_platforms as string[] | undefined) ?? [];
      out.push(
        evidence({
          source: 'meta-ads',
          kind: 'ad',
          key: id,
          url: libraryUrl(id),
          title: ((ad.ad_creative_link_titles as string[] | undefined) ?? [])[0] ?? '',
          text: bodies[0] ?? '',
          author: String(ad.page_name ?? ''),
          publishedAt: startedAt,
          metrics: {
            daysRunning: daysBetween(startedAt, endedAt),
            variants: Math.max(1, bodies.length),
            platforms: platforms.length || 1,
            active: endedAt ? 0 : 1,
            euReach: Number(ad.eu_total_reach),
          },
          attributes: {
            platforms,
            caption: ((ad.ad_creative_link_captions as string[] | undefined) ?? [])[0] ?? '',
            pageId: String(ad.page_id ?? ''),
            snapshotUrl: String(ad.ad_snapshot_url ?? ''),
          },
          query,
        }),
      );
    }
    next = page.paging?.next;
  }
  return out.slice(0, limit);
}

export const metaAds: Source = {
  id: 'meta-ads',
  label: 'Meta Ad Library (Facebook, Instagram, Messenger, Audience Network)',
  describe: 'Live and past Facebook/Instagram ads for a keyword or advertiser: copy, CTA, landing page, start date, variant count, platforms. Long-running ads with many variants are the proven winners.',
  queryHint: 'An advertiser/brand name or a keyword that appears in ad copy (e.g. "Gymshark", "meal prep delivery").',
  defaultLimit: 60,
  unavailable: () => '',
  async run(task, ctx) {
    const country = ctx.brief.country.toUpperCase();
    if (config.apis.metaAccessToken && DSA_COUNTRIES.has(country)) {
      ctx.log('  using the Ad Library API');
      return viaApi(task.query, country, task.limit);
    }
    type Item = { advertiser: string; text: string; headline: string; cta: string; startedOn: string; libraryId: string };
    const spec = (url: string, limit: number): BrowseSpec<Item> => ({
      url,
      jsonUrl: /facebook\.com\/api\/graphql/,
      isRecord: (node) => typeof node.ad_archive_id === 'string' && typeof node.snapshot === 'object',
      fromRecord: (node) => fromGraphql(node, task.query),
      instruction: 'Every ad shown: advertiser name, primary text, headline, call-to-action button text, the "Started running on" date, and the Library ID.',
      itemProperties: {
        advertiser: { type: 'string' },
        text: { type: 'string', description: 'The ad primary text.' },
        headline: { type: 'string' },
        cta: { type: 'string' },
        startedOn: { type: 'string', description: 'As written, e.g. "12 Mar 2026".' },
        libraryId: { type: 'string' },
      },
      itemKey: (item) => item.libraryId || `${item.advertiser}|${item.text.slice(0, 80)}`,
      fromItem: (item, sourceUrl) => {
        if (!item.text && !item.headline) return undefined;
        const startedAt = toIsoDate(item.startedOn);
        return evidence({
          source: 'meta-ads',
          kind: 'ad',
          key: item.libraryId || `${item.advertiser}|${item.text}`,
          url: item.libraryId ? libraryUrl(item.libraryId) : sourceUrl,
          title: item.headline,
          text: item.text,
          author: item.advertiser,
          publishedAt: startedAt,
          metrics: { daysRunning: daysBetween(startedAt, ''), variants: 1, active: 1 },
          attributes: { cta: item.cta },
          query: task.query,
        });
      },
      limit,
      maxScrolls: 10,
    });
    const library = (extra: Record<string, string>) =>
      `https://www.facebook.com/ads/library/?${new URLSearchParams({ active_status: 'active', ad_type: 'all', country, media_type: 'all', ...extra })}`;

    return withPage(async (page) => {
      const found = await browseAndExtract<Item>(page, spec(library({ q: task.query, search_type: 'keyword_unordered' }), task.limit), ctx);
      /**
       * A keyword search returns any ad that mentions the words. When the
       * query names an advertiser that appears in the results, its own page
       * of ads is the better answer: every ad it runs, not just matches.
       */
      const wanted = normalise(task.query);
      const pages = new Map<string, number>();
      for (const item of found) {
        const pageId = String(item.attributes.pageId ?? '');
        if (pageId && normalise(item.author).includes(wanted)) pages.set(pageId, (pages.get(pageId) ?? 0) + 1);
      }
      const advertiser = [...pages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!advertiser) return found;
      ctx.log(`  following advertiser page ${advertiser}`);
      const own = await browseAndExtract<Item>(page, spec(library({ view_all_page_id: advertiser, search_type: 'page' }), task.limit), ctx).catch(() => []);
      const merged = new Map([...own, ...found].map((item) => [item.id, item]));
      return [...merged.values()].slice(0, task.limit);
    });
  },
};
