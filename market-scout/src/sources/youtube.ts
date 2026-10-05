import { config } from '../config.js';
import { withPage } from '../browser/session.js';
import { pickString } from '../core/harvest.js';
import { httpJson } from '../core/politeness.js';
import { evidence, parseCount } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import { browseAndExtract, type Source } from './source.js';

/**
 * YouTube videos for a search or a channel.
 *
 * With YOUTUBE_API_KEY: Data API v3 — one search.list (100 units) and one
 * videos.list per 50 ids (1 unit) for exact statistics. Without: the public
 * results page, whose `ytInitialData` lists each video's views and age.
 */

interface ApiVideo {
  id: string;
  snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string; tags?: string[] };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

async function viaApi(query: string, limit: number, country: string): Promise<Evidence[]> {
  const key = config.apis.youtubeKey;
  const channel = query.startsWith('@');
  let ids: string[] = [];
  if (channel) {
    const found = await httpJson<{ items?: Array<{ id: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(query)}&key=${key}`,
      { api: true, minGapMs: 200 },
    );
    const uploads = found.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const list = await httpJson<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}&key=${key}`,
      { api: true, minGapMs: 200 },
    );
    ids = (list.items ?? []).map((item) => item.contentDetails?.videoId ?? '').filter(Boolean);
  } else {
    const search = await httpJson<{ items?: Array<{ id?: { videoId?: string } }> }>(
      `https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=${Math.min(50, limit)}&order=relevance&regionCode=${country}&q=${encodeURIComponent(query)}&key=${key}`,
      { api: true, minGapMs: 200 },
    );
    ids = (search.items ?? []).map((item) => item.id?.videoId ?? '').filter(Boolean);
  }
  const out: Evidence[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await httpJson<{ items?: ApiVideo[] }>(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${key}`,
      { api: true, minGapMs: 200 },
    );
    for (const video of batch.items ?? []) {
      out.push(
        evidence({
          source: 'youtube',
          kind: 'video',
          key: video.id,
          url: `https://www.youtube.com/watch?v=${video.id}`,
          title: video.snippet?.title ?? '',
          text: `${video.snippet?.title ?? ''}\n${(video.snippet?.description ?? '').slice(0, 1_000)}`,
          author: video.snippet?.channelTitle ?? '',
          publishedAt: video.snippet?.publishedAt ?? '',
          metrics: {
            views: Number(video.statistics?.viewCount),
            likes: Number(video.statistics?.likeCount),
            comments: Number(video.statistics?.commentCount),
          },
          attributes: { tags: video.snippet?.tags ?? [], duration: video.contentDetails?.duration ?? '' },
          query,
        }),
      );
    }
  }
  return out.slice(0, limit);
}

/** "3 weeks ago" → an approximate ISO date. */
export function relativeAge(text: string): string {
  const match = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(text);
  if (!match) return '';
  const unit = { second: 1, minute: 60, hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }[match[2].toLowerCase() as 'day'];
  return new Date(Date.now() - Number(match[1]) * unit * 1000).toISOString();
}

type VideoItem = { title: string; channel: string; views: string; age: string; url: string };

export const youtube: Source = {
  id: 'youtube',
  label: 'YouTube',
  describe: 'YouTube videos for a topic or a channel\'s uploads, with views, likes and comments: content demand, formats and titles that win.',
  queryHint: 'A search phrase, or "@handle" for a channel\'s latest uploads.',
  defaultLimit: 30,
  unavailable: () => '',
  async run(task, ctx) {
    if (config.apis.youtubeKey) return viaApi(task.query.trim(), task.limit, ctx.brief.country.toUpperCase());
    const q = task.query.trim();
    const url = q.startsWith('@') ? `https://www.youtube.com/${q}/videos` : `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    return withPage((page) =>
      browseAndExtract<VideoItem>(
        page,
        {
          url,
          jsonUrl: /youtube\.com\/youtubei\/v1\/(search|browse)/,
          isRecord: (node) => typeof node.videoId === 'string' && typeof node.title === 'object' && (node.viewCountText !== undefined || node.publishedTimeText !== undefined),
          fromRecord: (node) => {
            const id = pickString(node, 'videoId');
            const views = pickString(node, 'viewCountText.simpleText', 'viewCountText.runs.0.text');
            return evidence({
              source: 'youtube',
              kind: 'video',
              key: id,
              url: `https://www.youtube.com/watch?v=${id}`,
              title: pickString(node, 'title.runs.0.text', 'title.simpleText'),
              text: [pickString(node, 'title.runs.0.text', 'title.simpleText'), pickString(node, 'detailedMetadataSnippets.0.snippetText.runs.0.text', 'descriptionSnippet.runs.0.text')].filter(Boolean).join('\n'),
              author: pickString(node, 'ownerText.runs.0.text', 'longBylineText.runs.0.text'),
              publishedAt: relativeAge(pickString(node, 'publishedTimeText.simpleText')),
              metrics: { views: /no views/i.test(views) ? 0 : parseCount(views) },
              attributes: { length: pickString(node, 'lengthText.simpleText') },
              query: task.query,
            });
          },
          instruction: 'Every video listed: title, channel name, view count and upload age as displayed, and the video link.',
          itemProperties: {
            title: { type: 'string' },
            channel: { type: 'string' },
            views: { type: 'string' },
            age: { type: 'string' },
            url: { type: 'string' },
          },
          itemKey: (item) => item.url || item.title,
          fromItem: (item, sourceUrl) =>
            item.title
              ? evidence({
                  source: 'youtube',
                  kind: 'video',
                  key: item.url || item.title,
                  url: item.url || sourceUrl,
                  title: item.title,
                  text: item.title,
                  author: item.channel,
                  publishedAt: relativeAge(item.age),
                  metrics: { views: parseCount(item.views) },
                  query: task.query,
                })
              : undefined,
          limit: task.limit,
          maxScrolls: 4,
        },
        ctx,
      ),
    );
  },
};
