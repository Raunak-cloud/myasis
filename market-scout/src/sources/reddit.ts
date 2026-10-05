import { config } from '../config.js';
import { httpJson } from '../core/politeness.js';
import { evidence } from '../core/store.js';
import type { Evidence } from '../core/types.js';
import type { Source } from './source.js';

/**
 * Reddit, through its official Data API only.
 *
 * Unauthenticated `.json` and old.reddit have refused unidentified clients
 * since May 2026, and Reddit litigates against scrapers that work around
 * that, so there is no browser fallback here. App-only OAuth (client
 * credentials) is enough for public posts and comments. Reddit's free tier
 * is for non-commercial use; a commercial product needs its approval.
 */

let token: { value: string; expires: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${config.apis.redditClientId}:${config.apis.redditClientSecret}`).toString('base64');
  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': config.apis.redditUserAgent },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Reddit OAuth failed: HTTP ${response.status}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function api<T>(path: string): Promise<T> {
  // 100 queries a minute is the free allowance; one every 0.7 s stays under it.
  return httpJson<T>(`https://oauth.reddit.com${path}`, {
    api: true,
    minGapMs: 700,
    headers: { authorization: `Bearer ${await accessToken()}`, 'user-agent': config.apis.redditUserAgent },
  });
}

interface Thing {
  kind: string;
  data: Record<string, unknown> & { replies?: { data?: { children?: Thing[] } } | '' };
}

function fromPost(data: Record<string, unknown>, query: string): Evidence {
  const permalink = `https://www.reddit.com${String(data.permalink ?? '')}`;
  return evidence({
    source: 'reddit',
    kind: 'post',
    key: String(data.name ?? permalink),
    url: permalink,
    title: String(data.title ?? ''),
    text: `${String(data.title ?? '')}\n${String(data.selftext ?? '').slice(0, 3_000)}`,
    author: String(data.author ?? ''),
    publishedAt: new Date(Number(data.created_utc) * 1000).toISOString(),
    metrics: {
      score: Number(data.score),
      comments: Number(data.num_comments),
      upvoteRatio: Number(data.upvote_ratio),
      subscribers: Number(data.subreddit_subscribers),
    },
    attributes: { subreddit: String(data.subreddit ?? ''), flair: String(data.link_flair_text ?? ''), outboundUrl: data.is_self ? '' : String(data.url ?? '') },
    query,
  });
}

export const reddit: Source = {
  id: 'reddit',
  label: 'Reddit (official API)',
  describe: "Public Reddit posts and comments with verbatim quotations. These are potential customer perspectives; buyer identity and representativeness are not independently verified.",
  queryHint: 'A search phrase (e.g. "best crm for freelancers"), or "r/subreddit" for that community\'s top posts of the year. Add " in r/sub" to search within one community.',
  defaultLimit: 40,
  unavailable: () =>
    config.apis.redditClientId && config.apis.redditClientSecret
      ? ''
      : 'Reddit needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (a "script" app at reddit.com/prefs/apps); its anonymous endpoints are closed.',
  async run(task, ctx) {
    const q = task.query.trim();
    const sub = /^r\/(\w+)$/i.exec(q);
    const scoped = /^(.*)\s+in\s+r\/(\w+)$/i.exec(q);
    const limit = Math.min(100, task.limit);
    const path = sub
      ? `/r/${sub[1]}/top?t=year&limit=${limit}&raw_json=1`
      : scoped
        ? `/r/${scoped[2]}/search?q=${encodeURIComponent(scoped[1])}&restrict_sr=1&sort=relevance&t=year&limit=${limit}&raw_json=1`
        : `/search?q=${encodeURIComponent(q)}&sort=relevance&t=year&limit=${limit}&raw_json=1`;
    const listing = await api<{ data?: { children?: Thing[] } }>(path);
    const posts = (listing.data?.children ?? []).filter((child) => child.kind === 't3').map((child) => child.data);
    const out = posts.map((post) => fromPost(post, task.query));

    // Comments carry most of the voice of customer; read the busiest threads.
    const busiest = [...posts].sort((a, b) => Number(b.num_comments) - Number(a.num_comments)).slice(0, Math.min(8, Math.ceil(limit / 5)));
    for (const post of busiest) {
      try {
        const thread = await api<[unknown, { data?: { children?: Thing[] } }]>(`/comments/${String(post.id)}?sort=top&limit=40&depth=2&raw_json=1`);
        const walk = (things: Thing[] | undefined, depth: number) => {
          for (const thing of things ?? []) {
            if (thing.kind !== 't1') continue;
            const body = String(thing.data.body ?? '');
            if (body && body !== '[deleted]' && body !== '[removed]') {
              out.push(
                evidence({
                  source: 'reddit',
                  kind: 'comment',
                  key: String(thing.data.name),
                  url: `https://www.reddit.com${String(thing.data.permalink ?? '')}`,
                  title: String(post.title ?? ''),
                  text: body.slice(0, 2_000),
                  author: String(thing.data.author ?? ''),
                  publishedAt: new Date(Number(thing.data.created_utc) * 1000).toISOString(),
                  metrics: { score: Number(thing.data.score), depth },
                  attributes: { subreddit: String(post.subreddit ?? ''), thread: String(post.name ?? '') },
                  query: task.query,
                }),
              );
            }
            if (thing.data.replies && depth < 2) walk(thing.data.replies.data?.children, depth + 1);
          }
        };
        walk(thread[1]?.data?.children, 0);
      } catch (error) {
        ctx.log(`  reddit thread skipped: ${(error as Error).message}`);
      }
    }
    return out;
  },
};
