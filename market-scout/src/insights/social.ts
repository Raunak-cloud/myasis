import type { Evidence } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit, UNTRUSTED } from '../llm/extract.js';

/**
 * Organic content and voice of customer.
 *
 * Engagement is normalised the way each platform distributes: by views where
 * a feed decouples reach from followers (TikTok, YouTube, Reels), by
 * followers on Instagram feed posts, by score within the same search on
 * Reddit. A post is then compared with its own author's median — an outlier
 * ratio of 3× says the content, not the account size, did the work.
 *
 * Voice of customer is "message mining": celeris-1 lifts verbatim quotes of
 * pains, desires, objections and alternatives, and every quote is checked to
 * be an actual substring of its source before it is kept.
 */

export interface ScoredPost {
  id: string;
  source: string;
  url: string;
  author: string;
  text: string;
  engagementRate: number;
  outlier: number;
  velocity: number;
  metrics: Record<string, number>;
  baseline: 'creator sample' | 'search sample';
}

export interface VocQuote {
  evidenceId: string;
  url: string;
  type: 'pain' | 'desire' | 'objection' | 'alternative' | 'praise' | 'question';
  theme: string;
  quote: string;
  weight: number;
}

export interface VocTheme {
  theme: string;
  type: VocQuote['type'];
  mentions: number;
  weight: number;
  quotes: VocQuote[];
}

export interface SocialInsights {
  posts: number;
  topByPlatform: Record<string, ScoredPost[]>;
  hashtags: Array<{ tag: string; posts: number; medianEngagement: number }>;
  voc: VocTheme[];
}

const sum = (...values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (Number.isFinite(value) ? (value as number) : 0), 0);

function median(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Interactions over the audience the platform actually showed it to. */
export function engagementRate(item: Evidence): number {
  const m = item.metrics;
  const interactions = sum(m.likes, m.comments, m.shares, m.saves);
  // A page that showed views but no interaction counts has no rate to report, not a rate of zero.
  if (item.source !== 'reddit' && ![m.likes, m.comments, m.shares, m.saves].some(Number.isFinite)) return Number.NaN;
  if (item.source === 'reddit') return sum(m.score, m.comments);
  if (Number.isFinite(m.views) && m.views > 0) return interactions / m.views;
  if (Number.isFinite(m.followers) && m.followers > 0) return interactions / m.followers;
  return Number.NaN;
}

export function scorePosts(items: Evidence[]): ScoredPost[] {
  const posts = items.filter((item) => (item.kind === 'post' || item.kind === 'video') && item.source !== 'website' && item.source !== 'agent');
  const rates = new Map(posts.map((post) => [post.id, engagementRate(post)]));
  const baselines = new Map<string, number>();
  const basis = (post: Evidence) => post.source === 'reddit' ? 'score' : post.metrics.views > 0 ? 'views' : post.metrics.followers > 0 ? 'followers' : 'unknown';
  const baselineKey = (post: Evidence) => {
    const byAuthor = Boolean(post.author) && posts.filter((other) => other.source === post.source && other.author === post.author && basis(other) === basis(post)).length >= 3;
    return byAuthor ? `${post.source}|author|${post.author}|${basis(post)}` : `${post.source}|query|${post.query}|${basis(post)}`;
  };
  for (const post of posts) {
    const key = baselineKey(post);
    if (!baselines.has(key)) {
      baselines.set(key, median(posts.filter((other) => baselineKey(other) === key).map((other) => rates.get(other.id) ?? Number.NaN)));
    }
  }
  return posts.map((post) => {
    const rate = rates.get(post.id) ?? Number.NaN;
    const base = baselines.get(baselineKey(post)) ?? Number.NaN;
    const age = post.publishedAt ? (Date.parse(post.collectedAt) - Date.parse(post.publishedAt)) / 86_400_000 : Number.NaN;
    const ageDays = age >= 0 ? Math.max(1, age) : Number.NaN;
    const interactions = sum(post.metrics.likes, post.metrics.comments, post.metrics.shares, post.metrics.saves, post.metrics.score);
    return {
      id: post.id,
      source: post.source,
      url: post.url,
      author: post.author,
      text: post.text.slice(0, 400),
      engagementRate: Number.isFinite(rate) ? Number(rate.toFixed(4)) : Number.NaN,
      outlier: Number.isFinite(rate) && Number.isFinite(base) && base > 0 ? Number((rate / base).toFixed(2)) : Number.NaN,
      velocity: Number.isFinite(ageDays) ? Math.round(interactions / ageDays) : Number.NaN,
      metrics: post.metrics,
      baseline: baselineKey(post).includes('|author|') ? 'creator sample' : 'search sample',
    };
  });
}

function hashtagsOf(item: Evidence): string[] {
  const declared = item.attributes.hashtags;
  const fromText = [...item.text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((match) => match[1]);
  return [...new Set([...(Array.isArray(declared) ? declared : []), ...fromText].map((tag) => tag.toLowerCase()))];
}

const normalise = (text: string) => text.toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();

export async function analyzeSocial(all: Evidence[], meter: CostMeter): Promise<SocialInsights> {
  const scored = scorePosts(all);
  const topByPlatform: Record<string, ScoredPost[]> = {};
  for (const post of scored) (topByPlatform[post.source] ??= []).push(post);
  for (const [platform, posts] of Object.entries(topByPlatform)) {
    topByPlatform[platform] = posts
      .sort((a, b) => (Number.isFinite(b.outlier) ? b.outlier : 0) - (Number.isFinite(a.outlier) ? a.outlier : 0) || (b.engagementRate || 0) - (a.engagementRate || 0))
      .slice(0, 12);
  }

  const tagStats = new Map<string, number[]>();
  const rateById = new Map(scored.map((post) => [post.id, post.engagementRate]));
  for (const item of all) {
    for (const tag of hashtagsOf(item)) tagStats.set(tag, [...(tagStats.get(tag) ?? []), rateById.get(item.id) ?? Number.NaN]);
  }
  const hashtags = [...tagStats.entries()]
    .filter(([, rates]) => rates.length >= 2)
    .map(([tag, rates]) => ({ tag, posts: rates.length, medianEngagement: Number((median(rates) || 0).toFixed(4)) }))
    .sort((a, b) => b.posts - a.posts)
    .slice(0, 30);

  // ---- Voice of customer ----
  const conversational = all.filter((item) => item.attributes.reviewRole === 'customer' && item.text.length >= 40);
  const weightOf = (item: Evidence) => 1 + Math.log1p(Math.max(0, sum(item.metrics.score, item.metrics.likes, item.metrics.comments)));
  const ranked = [...conversational].sort((a, b) => weightOf(b) - weightOf(a)).slice(0, 240);
  const batches: Evidence[][] = [];
  for (let i = 0; i < ranked.length; i += 30) batches.push(ranked.slice(i, i + 30));

  const quotes: VocQuote[] = [];
  await mapLimit(batches, 3, async (batch) => {
    try {
      const reply = await askJson<{ quotes: Array<{ index: number; type: VocQuote['type']; theme: string; quote: string }> }>({
        model: 'celeris-1',
        system: `You mine customer language for copywriters. ${UNTRUSTED}`,
        prompt: `From each snippet, copy the exact words (verbatim, 4-30 words) where a person expresses a pain, a desire, an objection or hesitation, an alternative they use or compare, praise, or a question. Give each a short theme (2-5 words) that groups similar quotes. Skip snippets with none.\n\n${batch.map((item, index) => `[${index}] (${item.source}) ${item.text.slice(0, 1_200)}`).join('\n\n')}`,
        schema: {
          type: 'object',
          properties: {
            quotes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  type: { type: 'string', enum: ['pain', 'desire', 'objection', 'alternative', 'praise', 'question'] },
                  theme: { type: 'string' },
                  quote: { type: 'string' },
                },
              },
            },
          },
        },
        meter,
        maxTokens: 4_000,
      });
      for (const found of reply.quotes ?? []) {
        const item = batch[found.index];
        // Verbatim or nothing: a paraphrase is not voice of customer.
        if (!item || !found.quote || !normalise(item.text).includes(normalise(found.quote))) continue;
        quotes.push({ evidenceId: item.id, url: item.url, type: found.type, theme: found.theme, quote: found.quote, weight: weightOf(item) });
      }
    } catch {
      // A failed batch loses its quotes, not the run.
    }
  });

  let voc: VocTheme[] = [];
  if (quotes.length) {
    const themes = [...new Set(quotes.map((quote) => `${quote.type}: ${quote.theme.toLowerCase()}`))];
    let canonical = new Map<string, string>(themes.map((theme) => [theme, theme]));
    try {
      // Numbers in, numbers out: echoing every theme back as text is what runs a reply into its token ceiling.
      const reply = await askJson<{ groups: Array<{ name: string; members: number[] }> }>({
        model: 'celeris-1-magnus',
        system: 'You merge near-duplicate customer-research themes. Keep the type prefix (pain:, desire:, …) of the members; never merge across types. Refer to themes only by their numbers.',
        prompt: `Merge these themes into groups of the same meaning. Name each group in plain words with its type prefix. Every theme number belongs to exactly one group.\n\n${themes.map((theme, index) => `${index}. ${theme}`).join('\n')}`,
        schema: { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, members: { type: 'array', items: { type: 'integer' } } } } } } },
        meter,
        effort: 'low',
        maxTokens: 2_000,
      });
      canonical = new Map(themes.map((theme, index) => [theme, reply.groups?.find((group) => group.members?.includes(index))?.name ?? theme]));
    } catch {
      // Unmerged themes are noisier, still correct.
    }
    const grouped = new Map<string, VocTheme>();
    for (const quote of quotes) {
      const name = canonical.get(`${quote.type}: ${quote.theme.toLowerCase()}`) ?? quote.theme;
      const theme = grouped.get(name) ?? { theme: name.replace(/^\w+:\s*/, ''), type: quote.type, mentions: 0, weight: 0, quotes: [] };
      theme.mentions += 1;
      theme.weight += quote.weight;
      theme.quotes.push(quote);
      grouped.set(name, theme);
    }
    voc = [...grouped.values()]
      .map((theme) => ({ ...theme, weight: Number(theme.weight.toFixed(2)), quotes: theme.quotes.sort((a, b) => b.weight - a.weight).slice(0, 5) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 40);
  }

  return { posts: scored.length, topByPlatform, hashtags, voc };
}
