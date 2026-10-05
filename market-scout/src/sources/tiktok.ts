import { withPage } from '../browser/session.js';
import { pick, pickNumber, pickString, toIsoDate } from '../core/harvest.js';
import { evidence, parseCount } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import { browseAndExtract, type Source } from './source.js';

/**
 * TikTok, logged out: public profiles, hashtag pages and search, plus the
 * Creative Center's trend boards and the EU ad library.
 *
 * Video pages carry their data in the `__UNIVERSAL_DATA_FOR_REHYDRATION__`
 * blob and in `/api/.../item_list` responses; both are read as JSON.
 */

const isVideo = (node: Record<string, unknown>) =>
  typeof node.id === 'string' && typeof node.desc === 'string' && (typeof node.stats === 'object' || typeof node.statsV2 === 'object');

function fromVideo(node: Record<string, unknown>, query: string): Evidence | undefined {
  const id = pickString(node, 'id');
  const author = pickString(node, 'author.uniqueId', 'author');
  if (!id) return undefined;
  const stat = (key: string) => {
    const value = pickNumber(node, `stats.${key}`);
    return Number.isFinite(value) ? value : parseCount(pickString(node, `statsV2.${key}`));
  };
  const hashtags = ((pick(node, 'textExtra') as Array<{ hashtagName?: string }> | undefined) ?? [])
    .map((tag) => tag.hashtagName ?? '')
    .filter(Boolean);
  return evidence({
    source: 'tiktok',
    kind: 'video',
    key: id,
    url: `https://www.tiktok.com/@${author}/video/${id}`,
    title: pickString(node, 'desc').slice(0, 120),
    text: pickString(node, 'desc'),
    author,
    publishedAt: toIsoDate(pick(node, 'createTime')),
    metrics: {
      views: stat('playCount'),
      likes: stat('diggCount'),
      comments: stat('commentCount'),
      shares: stat('shareCount'),
      saves: stat('collectCount'),
      followers: pickNumber(node, 'authorStats.followerCount', 'authorStatsV2.followerCount'),
      durationSec: pickNumber(node, 'video.duration'),
    },
    attributes: {
      hashtags,
      sound: pickString(node, 'music.title'),
      isAd: pick(node, 'isAd') === true ? 'yes' : 'no',
    },
    query,
  });
}

type VideoItem = { author: string; caption: string; views: string; likes: string; url: string };
const videoItem = {
  instruction: 'Every video shown: creator handle, caption, view count and like count as displayed, and the video link.',
  itemProperties: {
    author: { type: 'string' },
    caption: { type: 'string' },
    views: { type: 'string', description: 'As displayed, e.g. "1.2M".' },
    likes: { type: 'string' },
    url: { type: 'string' },
  },
  itemKey: (item: VideoItem) => item.url || `${item.author}|${item.caption.slice(0, 60)}`,
};

export const tiktok: Source = {
  id: 'tiktok',
  label: 'TikTok (public profiles, hashtags, search)',
  describe: 'Organic TikTok videos with views, likes, comments, shares and saves: what content and hooks get traction in a niche or for a competitor.',
  queryHint: '"@handle" for a creator or brand profile, or a search phrase or "#tag" (searched; hashtag pages are closed to logged-out visitors).',
  defaultLimit: 40,
  unavailable: () => '',
  async run(task, ctx) {
    const q = task.query.trim();
    // Hashtag pages show "Page not available" logged out (Oct 2026); searching for the tag works.
    const url = q.startsWith('@') ? `https://www.tiktok.com/${q}` : `https://www.tiktok.com/search/video?q=${encodeURIComponent(q)}`;
    return withPage((page) =>
      browseAndExtract<VideoItem>(
        page,
        {
          url,
          jsonUrl: /tiktok\.com\/api\/(post\/item_list|challenge\/item_list|search|recommend)/,
          isRecord: isVideo,
          fromRecord: (node) => fromVideo(node, task.query),
          ...videoItem,
          fromItem: (item, sourceUrl) =>
            item.caption || item.url
              ? evidence({
                  source: 'tiktok',
                  kind: 'video',
                  key: item.url || `${item.author}|${item.caption}`,
                  url: item.url || sourceUrl,
                  title: item.caption.slice(0, 120),
                  text: item.caption,
                  author: item.author.replace(/^@/, ''),
                  metrics: { views: parseCount(item.views), likes: parseCount(item.likes) },
                  query: task.query,
                })
              : undefined,
          limit: task.limit,
          maxScrolls: 8,
        },
        ctx,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// Creative Center and the ad library
// ---------------------------------------------------------------------------

type TrendItem = { name: string; kind: string; rank: string; posts: string; views: string; detail: string };

export const tiktokCreative: Source = {
  id: 'tiktok-creative',
  label: 'TikTok Creative Center and Ad Library',
  describe: 'TikTok trend boards (rising hashtags, songs, top ads with CTR and likes where shown anonymously) and the TikTok ad library (EU-served ads, by advertiser or keyword).',
  queryHint: '"hashtags" for trending hashtags in the brief\'s country, "songs" for trending sounds, "topads:<keyword>" for top ads, or "library:<advertiser or keyword>" for the EU ad library.',
  defaultLimit: 40,
  unavailable: () => '',
  async run(task, ctx) {
    const country = ctx.brief.country.toUpperCase();
    const [mode, ...rest] = task.query.split(':');
    const term = rest.join(':').trim();
    const base = 'https://ads.tiktok.com/business/creativecenter';
    const target = {
      hashtags: { url: `${base}/inspiration/popular/hashtag/pc/en?countryCode=${country}&period=7`, kind: 'hashtag' as const },
      songs: { url: `${base}/inspiration/popular/music/pc/en?countryCode=${country}&period=7`, kind: 'trend' as const },
      topads: { url: `${base}/inspiration/topads/pc/en?period=30&region=${country}${term ? `&keyword=${encodeURIComponent(term)}` : ''}`, kind: 'ad' as const },
      library: { url: `https://library.tiktok.com/ads?region=all&adv_name=${encodeURIComponent(term)}&query_type=1&sort_type=last_shown_date,desc`, kind: 'ad' as const },
    }[mode.trim().toLowerCase() as 'hashtags' | 'songs' | 'topads' | 'library'];
    if (!target) throw new Error(`Unknown TikTok Creative Center mode "${mode}"`);

    const isTrend = (node: Record<string, unknown>) =>
      typeof (node.hashtag_name ?? node.title ?? node.ad_title) === 'string' &&
      (node.rank !== undefined || node.publish_cnt !== undefined || node.ctr !== undefined || node.video_views !== undefined);

    const found = await withPage((page) =>
      browseAndExtract<TrendItem>(
        page,
        {
          url: target.url,
          jsonUrl: /creative_radar_api|library\.tiktok\.com\/api/,
          isRecord: isTrend,
          fromRecord: (node) => {
            const name = pickString(node, 'hashtag_name', 'title', 'ad_title');
            const id = pickString(node, 'id', 'hashtag_id', 'clip_id', 'song_id') || name;
            return evidence({
              source: 'tiktok-creative',
              kind: target.kind,
              key: `${mode}:${id}`,
              url: target.kind === 'hashtag' ? `https://www.tiktok.com/tag/${encodeURIComponent(name)}` : target.url,
              title: name,
              text: [pickString(node, 'ad_title', 'title', 'hashtag_name'), pickString(node, 'industry_key', 'objective_key')].filter(Boolean).join(' · '),
              author: pickString(node, 'brand_name', 'author', 'creator'),
              metrics: {
                rank: pickNumber(node, 'rank'),
                posts: pickNumber(node, 'publish_cnt'),
                views: pickNumber(node, 'video_views'),
                likes: pickNumber(node, 'like'),
                ctr: pickNumber(node, 'ctr'),
                rankChange: pickNumber(node, 'rank_diff'),
                cost: pickNumber(node, 'cost'),
              },
              attributes: {
                industry: pickString(node, 'industry_info.value', 'industry_key'),
                objective: pickString(node, 'objective_key'),
                landingUrl: pickString(node, 'landing_page'),
                video: pickString(node, 'video_info.vid', 'video_info.video_url.720p'),
              },
              query: task.query,
            });
          },
          instruction:
            target.kind === 'ad'
              ? 'Every ad listed: ad title or caption as "name", advertiser in "detail", its rank, likes or reach as shown in "views", CTR or other stats in "detail".'
              : 'Every ranked item listed: its name, its rank, number of posts, number of views, and anything else shown in "detail".',
          itemProperties: {
            name: { type: 'string' },
            kind: { type: 'string', description: 'hashtag, song, creator or ad' },
            rank: { type: 'string' },
            posts: { type: 'string' },
            views: { type: 'string' },
            detail: { type: 'string' },
          },
          itemKey: (item) => item.name,
          fromItem: (item, sourceUrl) =>
            item.name
              ? evidence({
                  source: 'tiktok-creative',
                  kind: target.kind,
                  key: `${mode}:${item.name}`,
                  url: sourceUrl,
                  title: item.name,
                  text: [item.name, item.detail].filter(Boolean).join(' · '),
                  metrics: { rank: parseCount(item.rank), posts: parseCount(item.posts), views: parseCount(item.views) },
                  attributes: { kind: item.kind },
                  query: task.query,
                })
              : undefined,
          agentGoal:
            mode === 'library'
              ? `Find ads by or about "${term}" in the TikTok ad library (search by advertiser name, then open results) and extract each ad: advertiser, caption, first and last shown dates, reach.`
              : undefined,
          allowedHosts: ['tiktok.com'],
          limit: task.limit,
          maxScrolls: 4,
        },
        ctx,
      ),
    );
    /**
     * Logged out, the Creative Center ignores the keyword and shows its
     * global top ads (YSL, pasta, electronics for a Nepali-wear search).
     * Only items that actually mention the keyword are kept.
     */
    if (mode.trim().toLowerCase() !== 'topads' || !term) return found;
    const words = term.toLowerCase().split(/\s+/).filter((word) => word.length >= 4);
    const relevant = found.filter((item) => words.some((word) => `${item.title} ${item.text}`.toLowerCase().includes(word)));
    if (relevant.length < found.length) ctx.log(`  kept ${relevant.length} of ${found.length} top ads; the rest do not mention "${term}" (the logged-out Creative Center ignores keywords)`);
    return relevant;
  },
};
