import { config } from '../config.js';
import { runAgent } from '../agent/agent.js';
import { visit, withPage } from '../browser/session.js';
import { pickString, toIsoDate } from '../core/harvest.js';
import { BlockedError, httpJson } from '../core/politeness.js';
import { evidence } from '../core/store.js';
import { askJson } from '../llm/celeris.js';
import { UNTRUSTED } from '../llm/extract.js';
import { browseAndExtract, type Source } from './source.js';

/**
 * The other public ad libraries — Google's Ads Transparency Center and
 * LinkedIn's Ad Library — plus Pinterest's official trends API.
 *
 * Neither ad library has a public commercial-ads API, and both render
 * through private RPC formats, so they are read as rendered text by
 * celeris-1, with the browser agent for searches no URL can express.
 */

type AdItem = { advertiser: string; text: string; headline: string; cta: string; format: string; firstShown: string; lastShown: string; url: string };

const adItem = {
  itemProperties: {
    advertiser: { type: 'string' },
    text: { type: 'string', description: 'The ad body copy, if readable.' },
    headline: { type: 'string' },
    cta: { type: 'string' },
    format: { type: 'string', description: 'text, image, video or carousel' },
    firstShown: { type: 'string', description: 'First shown / started date as written.' },
    lastShown: { type: 'string', description: 'Last shown date as written.' },
    url: { type: 'string', description: 'The link to this ad\'s detail page, if present.' },
  },
  itemKey: (item: AdItem) => item.url || `${item.advertiser}|${item.headline}|${item.text.slice(0, 80)}`,
};

function daysRunning(first: string, last: string): number {
  const start = Date.parse(first);
  if (!Number.isFinite(start)) return Number.NaN;
  const end = Number.isFinite(Date.parse(last)) ? Date.parse(last) : Date.now();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

export const googleAds: Source = {
  id: 'google-ads',
  label: 'Google Ads Transparency Center (Search, YouTube, Display, Shopping)',
  describe: 'Every Google ad (Search, YouTube, Display) an advertiser is running, by domain or advertiser name: formats, copy, how long each has run.',
  queryHint: 'The advertiser\'s website domain (best, e.g. "hubspot.com") or the advertiser\'s legal/brand name.',
  defaultLimit: 40,
  unavailable: () => '',
  /**
   * The centre's SearchCreatives RPC lists every creative with its advertiser,
   * format and first/last-shown timestamps — the longevity signal — under
   * numbered protobuf keys. Creative text is not in it (each ad renders in a
   * sandboxed frame), so the longest-running creatives are then opened one by
   * one and their frames read.
   */
  async run(task, ctx) {
    const q = task.query.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const isDomain = /^[\w-]+(\.[\w-]+)+$/.test(q);
    const region = ctx.brief.country.toUpperCase() === 'UK' ? 'GB' : ctx.brief.country.toUpperCase();
    return withPage(async (page) => {
      let url = `https://adstransparency.google.com/?region=${region}&domain=${q}`;
      if (!isDomain) {
        const found = await runAgent(page, {
          goal: `Open the Ads Transparency Center page of the advertiser "${q}": type the name into the search box and choose the matching advertiser from the suggestions. Call done as soon as that advertiser's ads page is open.`,
          startUrl: `https://adstransparency.google.com/?region=${region}`,
          recordProperties: { note: { type: 'string' } },
          recordKey: () => '',
          meter: ctx.meter,
          maxSteps: 8,
          allowedHosts: ['adstransparency.google.com'],
          log: ctx.log,
        });
        if (!/\/advertiser\/AR/.test(page.url())) throw new Error(`Advertiser "${q}" not found in the Ads Transparency Center (${found.summary})`);
        url = page.url();
      }
      const ads = await browseAndExtract<AdItem>(
        page,
        {
          url,
          jsonUrl: /SearchService\/SearchCreatives/,
          isRecord: (node) => typeof node['2'] === 'string' && String(node['2']).startsWith('CR') && typeof node['12'] === 'string',
          fromRecord: (node) => {
            const advertiserId = String(node['1']);
            const creativeId = String(node['2']);
            const first = toIsoDate(pickString(node, '6.1'));
            const last = toIsoDate(pickString(node, '7.1'));
            const format = ({ 1: 'text', 2: 'image', 3: 'video' } as Record<string, string>)[String(node['4'])] ?? 'other';
            return evidence({
              source: 'google-ads',
              kind: 'ad',
              key: creativeId,
              url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=${region}`,
              title: '',
              text: '',
              author: String(node['12']),
              publishedAt: first,
              metrics: { daysRunning: daysRunning(first, last), variants: 1, active: Date.now() - Date.parse(last) < 3 * 86_400_000 ? 1 : 0 },
              attributes: { format, lastShown: last, domain: pickString(node, '14') },
              query: task.query,
            });
          },
          textFallback: false,
          instruction: '',
          ...adItem,
          fromItem: () => undefined,
          limit: task.limit,
          maxScrolls: 3,
        },
        ctx,
      );

      /**
       * Read the copy of the longest-running creatives. Text ads render in a
       * scripted frame and image ads carry their copy in pixels, so the
       * rendered creative is read by celeris-1 from a screenshot — one path
       * for both formats.
       */
      const longest = [...ads].sort((a, b) => (b.metrics.daysRunning ?? 0) - (a.metrics.daysRunning ?? 0)).slice(0, 8);
      for (const ad of longest) {
        try {
          await visit(page, ad.url);
          await page.waitForTimeout(2_500);
          const shot = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')}`;
          const copy = await askJson<{ readable: boolean; headline: string; body: string; cta: string }>({
            model: 'celeris-1',
            system: `You transcribe ads exactly as shown. ${UNTRUSTED}`,
            prompt: [
              { type: 'text', text: `This is the Google Ads Transparency Center page for one ${String(ad.attributes.format)} ad by ${ad.author}. Transcribe the ad creative itself (not the page around it): its headline, body copy and call to action, word for word. If the creative shows no readable words (or is a video player), set readable to false.` },
              { type: 'image_url', image_url: { url: shot } },
            ],
            schema: { type: 'object', properties: { readable: { type: 'boolean' }, headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } },
            meter: ctx.meter,
            maxTokens: 800,
          });
          if (copy.readable && (copy.headline || copy.body)) {
            ad.title = copy.headline;
            ad.text = copy.body || copy.headline;
            ad.attributes.cta = copy.cta;
          }
        } catch (error) {
          ctx.log(`  could not read creative: ${(error as Error).message.split('\n')[0]}`);
          if (error instanceof BlockedError) break;
        }
      }
      return ads;
    });
  },
};

export const linkedinAds: Source = {
  id: 'linkedin-ads',
  label: 'LinkedIn Ad Library',
  describe: 'B2B ads a company runs on LinkedIn: copy, headline, CTA, format, and run dates. Best for B2B and recruiting competitors.',
  queryHint: 'The company name as it appears on LinkedIn (e.g. "Salesforce"), or "keyword:<phrase>" to search ad text.',
  defaultLimit: 30,
  unavailable: () => '',
  async run(task, ctx) {
    const q = task.query.trim();
    const keyword = q.toLowerCase().startsWith('keyword:');
    const term = keyword ? q.slice('keyword:'.length).trim() : q;
    const url = `https://www.linkedin.com/ad-library/search?${keyword ? 'keyword' : 'accountOwner'}=${encodeURIComponent(term)}`;
    return withPage((page) =>
      browseAndExtract<AdItem>(
        page,
        {
          url,
          instruction: 'Every ad card: the advertiser, the ad body text, headline, CTA button text, format, any run dates, and the "View details" link.',
          ...adItem,
          fromItem: (item, sourceUrl) =>
            item.text || item.headline
              ? evidence({
                  source: 'linkedin-ads',
                  kind: 'ad',
                  key: item.url || `${item.advertiser}|${item.headline}|${item.text}`,
                  url: item.url ? new URL(item.url, 'https://www.linkedin.com').toString() : sourceUrl,
                  title: item.headline,
                  text: item.text,
                  author: item.advertiser,
                  metrics: { daysRunning: daysRunning(item.firstShown, item.lastShown), variants: 1 },
                  attributes: { cta: item.cta, format: item.format },
                  query: task.query,
                })
              : undefined,
          limit: task.limit,
          maxScrolls: 0,
        },
        ctx,
      ),
    );
  },
};

interface PinterestTrend {
  keyword: string;
  pct_growth_wow?: number;
  pct_growth_mom?: number;
  pct_growth_yoy?: number;
}

export const pinterestTrends: Source = {
  id: 'trends',
  label: 'Pinterest Trends (official API)',
  describe: 'Rising and seasonal search keywords on Pinterest, with week/month/year growth — early demand signals for consumer, home, food, fashion and gifting niches.',
  queryHint: '"growing", "monthly", "yearly" or "seasonal", optionally followed by ":<interest>" (e.g. "growing:food_and_drinks").',
  defaultLimit: 50,
  unavailable: () => (config.apis.pinterestToken ? '' : 'Pinterest Trends needs PINTEREST_ACCESS_TOKEN (a Pinterest developer app).'),
  async run(task, ctx) {
    const [type, interest] = task.query.split(':').map((part) => part.trim().toLowerCase());
    const region = ctx.brief.country.toUpperCase() === 'UK' ? 'GB' : ctx.brief.country.toUpperCase();
    const params = new URLSearchParams({ limit: String(Math.min(50, task.limit)) });
    if (interest) params.set('interests', interest);
    const body = await httpJson<{ trends?: PinterestTrend[] }>(
      `https://api.pinterest.com/v5/trends/keywords/${region}/top/${type || 'growing'}?${params}`,
      { api: true, minGapMs: 1_000, headers: { authorization: `Bearer ${config.apis.pinterestToken}` } },
    );
    return (body.trends ?? []).map((trend, index) =>
      evidence({
        source: 'trends',
        kind: 'trend',
        key: `pinterest:${region}:${trend.keyword}`,
        url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(trend.keyword)}`,
        title: trend.keyword,
        text: trend.keyword,
        metrics: { rank: index + 1, growthWoW: Number(trend.pct_growth_wow), growthMoM: Number(trend.pct_growth_mom), growthYoY: Number(trend.pct_growth_yoy) },
        attributes: { platform: 'pinterest', trendType: type || 'growing', interest: interest ?? '' },
        query: task.query,
      }),
    );
  },
};
