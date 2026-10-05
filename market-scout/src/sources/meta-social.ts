import { config } from '../config.js';
import type { Page } from 'patchright';
import { visit, withPage } from '../browser/session.js';
import { pick, pickNumber, pickString, toIsoDate } from '../core/harvest.js';
import { httpJson } from '../core/politeness.js';
import { evidence, parseCount } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import { browseAndExtract, type Source } from './source.js';

/**
 * Organic Instagram and Facebook.
 *
 * Instagram: the Graph API's `business_discovery` is the durable route (any
 * public Business/Creator account, read through your own). Without it, the
 * public profile page logged out — which Instagram increasingly walls after
 * a few requests; a wall ends the source for the run, by design.
 *
 * Facebook pages show a few posts before a login wall; useful for a
 * competitor's recent organic posting, nothing more. The Ad Library
 * (meta-ads) is the richer Meta source.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v23.0';

async function businessDiscovery(handle: string, limit: number, query: string): Promise<Evidence[]> {
  const fields = `business_discovery.username(${handle}){username,name,biography,followers_count,media_count,website,media.limit(${Math.min(limit, 100)}){id,caption,like_count,comments_count,timestamp,permalink,media_type,media_product_type}}`;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${config.apis.instagramBusinessId}?fields=${encodeURIComponent(fields)}&access_token=${config.apis.instagramToken}`;
  const body = await httpJson<{ business_discovery?: Record<string, unknown> }>(url, { api: true, minGapMs: 18_000 });
  const profile = body.business_discovery ?? {};
  const followers = pickNumber(profile, 'followers_count');
  const out: Evidence[] = [
    evidence({
      source: 'instagram',
      kind: 'profile',
      key: `profile:${handle}`,
      url: `https://www.instagram.com/${handle}/`,
      title: pickString(profile, 'name') || handle,
      text: pickString(profile, 'biography'),
      author: handle,
      metrics: { followers, posts: pickNumber(profile, 'media_count') },
      attributes: { website: pickString(profile, 'website') },
      query,
    }),
  ];
  for (const media of ((pick(profile, 'media.data') as Array<Record<string, unknown>>) ?? [])) {
    const caption = pickString(media, 'caption');
    out.push(
      evidence({
        source: 'instagram',
        kind: 'post',
        key: pickString(media, 'id'),
        url: pickString(media, 'permalink'),
        title: caption.slice(0, 120),
        text: caption,
        author: handle,
        publishedAt: toIsoDate(pick(media, 'timestamp')),
        metrics: { likes: pickNumber(media, 'like_count'), comments: pickNumber(media, 'comments_count'), followers },
        attributes: { format: pickString(media, 'media_product_type', 'media_type') },
        query,
      }),
    );
  }
  return out;
}

type PostItem = { author: string; text: string; likes: string; comments: string; url: string; date: string };
const postItem = {
  itemProperties: {
    author: { type: 'string' },
    text: { type: 'string', description: 'The post caption or text.' },
    likes: { type: 'string', description: 'As displayed.' },
    comments: { type: 'string' },
    url: { type: 'string', description: 'Link to the post, if shown.' },
    date: { type: 'string' },
  },
  itemKey: (item: PostItem) => item.url || `${item.author}|${item.text.slice(0, 80)}`,
};

export const instagram: Source = {
  id: 'instagram',
  label: 'Instagram (public profiles)',
  describe: "A sample of public Instagram posts and available follower, view and interaction counts. These do not establish sales or buyer demand.",
  queryHint: '"@handle" of a public account (brand, competitor or creator).',
  defaultLimit: 30,
  unavailable: () => '',
  async run(task, ctx) {
    const handle = task.query.trim().replace(/^@/, '').replace(/^#.*/, '');
    if (!handle) throw new Error('Instagram needs an @handle; hashtag pages require signing in.');
    if (config.apis.instagramBusinessId && config.apis.instagramToken) {
      ctx.log('  using Instagram business_discovery');
      return businessDiscovery(handle, task.limit, task.query);
    }
    return withPage((page) => loggedOutProfile(page, handle, task.limit, task.query, ctx.log));
  },
};

/**
 * Logged out (Oct 2026), Instagram refuses its post GraphQL queries
 * ("Unauthorized logged out query") but still renders the profile grid and
 * each post page — whose meta description states likes, comments, date and
 * caption, and whose body shows the first comments. So: the grid for links,
 * then each post page, read deterministically. Instagram walls quickly; a
 * wall ends the walk and keeps what was read.
 */
async function loggedOutProfile(page: Page, handle: string, limit: number, query: string, log: (line: string) => void): Promise<Evidence[]> {
  await visit(page, `https://www.instagram.com/${handle}/`);
  const profile = await page.evaluate(() => ({
    description: document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
    title: document.title,
    links: [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]')].map((a) => a.href),
  }));
  // "8.6M Followers, 69 Following, 9,012 Posts - See Instagram photos and videos from Gymshark (@gymshark)"
  const followers = parseCount(/([\d.,]+[KMB]?)\s+Followers/i.exec(profile.description)?.[1] ?? '');
  const posts = parseCount(/([\d.,]+[KMB]?)\s+Posts/i.exec(profile.description)?.[1] ?? '');
  const out: Evidence[] = [
    evidence({
      source: 'instagram',
      kind: 'profile',
      key: `profile:${handle}`,
      url: `https://www.instagram.com/${handle}/`,
      title: profile.title,
      text: profile.description,
      author: handle,
      metrics: { followers, posts },
      query,
    }),
  ];

  // Each post is one page view; keep it to what the task needs.
  for (const url of [...new Set(profile.links)].slice(0, Math.min(limit, 15))) {
    try {
      await visit(page, url, { minGapMs: 4_000 });
    } catch (error) {
      log(`  instagram stopped after ${out.length - 1} posts: ${(error as Error).message}`);
      break;
    }
    const meta = await page.evaluate(() => ({
      description: document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
      body: (document.querySelector('main')?.innerText ?? '').slice(0, 2_500),
    }));
    // "20K likes, 86 comments - gymshark on October 3, 2026: "caption"."
    const match = /^([\d.,]+[KMB]?)\s+likes?,\s+([\d.,]+[KMB]?)\s+comments?\s+-\s+\S+\s+on\s+([^:]+):\s+"([\s\S]*)"\.?\s*$/i.exec(meta.description);
    if (!match) continue;
    const caption = match[4].trim();
    // What follows the caption in the page body is the first visible comments.
    const afterCaption = meta.body.split(caption.split('\n').at(-1) ?? caption).slice(1).join(' ');
    const comments = afterCaption.replace(/\b(Like|Reply|View replies.*?)\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_500);
    out.push(
      evidence({
        source: 'instagram',
        kind: 'post',
        key: url.replace(/\?.*$/, ''),
        url,
        title: caption.slice(0, 120),
        text: comments ? `${caption}\n\nComments: ${comments}` : caption,
        author: handle,
        publishedAt: toIsoDate(match[3]),
        metrics: { likes: parseCount(match[1]), comments: parseCount(match[2]), followers },
        attributes: { format: /\/reel\//.test(url) ? 'reel' : 'post', caption },
        query,
      }),
    );
  }
  return out;
}

export const facebook: Source = {
  id: 'facebook',
  label: 'Facebook (public pages)',
  describe: 'Recent public posts on a brand\'s Facebook page with reactions and comments, as far as Facebook shows logged out (usually a handful).',
  queryHint: 'The page\'s username or URL path (e.g. "nike" for facebook.com/nike).',
  defaultLimit: 10,
  unavailable: () => '',
  async run(task, ctx) {
    const slug = task.query.trim().replace(/^https?:\/\/(www\.)?facebook\.com\//, '').replace(/^@/, '').replace(/\/$/, '');
    return withPage((page) =>
      browseAndExtract<PostItem>(
        page,
        {
          url: `https://www.facebook.com/${slug}`,
          instruction: 'Every post on this page: the page name as author, the post text, reactions count as likes, comments count, the post link and date.',
          ...postItem,
          fromItem: (item, sourceUrl) =>
            item.text
              ? evidence({
                  source: 'facebook',
                  kind: 'post',
                  key: item.url || `${slug}|${item.text}`,
                  url: item.url || sourceUrl,
                  title: item.text.slice(0, 120),
                  text: item.text,
                  author: item.author || slug,
                  publishedAt: toIsoDate(item.date),
                  metrics: { likes: parseCount(item.likes), comments: parseCount(item.comments) },
                  query: task.query,
                })
              : undefined,
          limit: task.limit,
        },
        ctx,
      ),
    );
  },
};
