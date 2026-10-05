import { createHash } from 'node:crypto';
import type { Evidence } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit, UNTRUSTED } from '../llm/extract.js';

/** Rank observed ad date spans, variants and placements. These signals do not
 * establish spend, continuous activity, conversions or profitability. */

/** Brand advertisers mostly open with slogans, product shots and launches; without those the tagger filed two ads in three under "other". */
export const HOOKS = ['question', 'bold claim', 'problem callout', 'testimonial', 'demo', 'us vs them', 'statistic', 'founder story', 'offer first', 'curiosity', 'social proof', 'how-to', 'identity statement', 'product showcase', 'new launch', 'seasonal or event', 'other'] as const;
export const AWARENESS = ['unaware', 'problem-aware', 'solution-aware', 'product-aware', 'most-aware'] as const;

export interface ScoredAd {
  id: string;
  url: string;
  advertiser: string;
  source: string;
  text: string;
  headline: string;
  cta: string;
  daysRunning: number;
  variants: number;
  platforms: number;
  active: boolean | null;
  score: number;
  tier: '90+ days observed' | '60–89 days observed' | '30–59 days observed' | 'under 30 days observed' | 'unknown age';
  tags?: AdTags;
}

export interface AdTags {
  hook: string;
  angle: string;
  awareness: string;
  offer: string;
  proof: string;
  emotion: string;
}

export interface AdInsights {
  total: number;
  advertisers: Array<{ name: string; ads: number; active: number; medianDays: number; longest: number }>;
  winners: ScoredAd[];
  /** Tag → score-weighted share, highest first. */
  patterns: Record<'hook' | 'awareness' | 'offer' | 'proof' | 'emotion' | 'cta', Array<{ value: string; weight: number; ads: number }>>;
  angles: Array<{ angle: string; advertiser: string; evidenceId: string }>;
}

export function tierFor(days: number): ScoredAd['tier'] {
  if (!Number.isFinite(days)) return 'unknown age';
  if (days >= 90) return '90+ days observed';
  if (days >= 60) return '60–89 days observed';
  if (days >= 30) return '30–59 days observed';
  return 'under 30 days observed';
}

/** log(days) × (1 + log(variants)) × placement breadth × still-running. */
export function scoreAd(days: number, variants: number, platforms: number, active: boolean | null): number {
  const age = Number.isFinite(days) ? Math.log(1 + days) : Math.log(1 + 7);
  return Number((age * (1 + Math.log(Math.max(1, variants))) * (1 + 0.15 * (Math.max(1, platforms) - 1)) * (active ? 1 : 0.75)).toFixed(3));
}

/** Copy normalised so that one concept with small edits is one group. */
export function conceptKey(text: string): string {
  const normal = text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  return createHash('sha1').update(normal).digest('hex').slice(0, 10);
}

export function scoreAds(items: Evidence[]): ScoredAd[] {
  // Ads without readable copy (image and video creatives) still count for longevity.
  const ads = items.filter((item) => item.kind === 'ad');
  const concept = (ad: Evidence) => `${ad.author}|${ad.text || ad.title ? conceptKey(ad.text || ad.title) : ad.id}`;
  // Variants: the library's own count where given, else identical concepts by the same advertiser.
  const groups = new Map<string, number>();
  for (const ad of ads) groups.set(concept(ad), (groups.get(concept(ad)) ?? 0) + 1);
  return ads.map((ad) => {
    const days = ad.metrics.daysRunning ?? Number.NaN;
    const variants = Math.max(ad.metrics.variants ?? 1, groups.get(concept(ad)) ?? 1);
    const platforms = ad.metrics.platforms ?? 1;
    const active = Number.isFinite(ad.metrics.active) ? ad.metrics.active === 1 : null;
    return {
      id: ad.id,
      url: ad.url,
      advertiser: ad.author || `Unidentified advertiser (${ad.id})`,
      source: ad.source,
      text: ad.text,
      headline: ad.title,
      cta: String(ad.attributes.cta ?? ''),
      daysRunning: days,
      variants,
      platforms,
      active,
      score: scoreAd(days, variants, platforms, active),
      tier: tierFor(days),
    };
  });
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function analyzeAds(all: Evidence[], meter: CostMeter): Promise<AdInsights> {
  const scored = scoreAds(all);
  const byAdvertiser = new Map<string, ScoredAd[]>();
  for (const ad of scored) byAdvertiser.set(ad.advertiser, [...(byAdvertiser.get(ad.advertiser) ?? []), ad]);

  const advertisers = [...byAdvertiser.entries()]
    .map(([name, ads]) => ({
      name,
      ads: ads.length,
      active: ads.filter((ad) => ad.active).length,
      medianDays: median(ads.map((ad) => ad.daysRunning)),
      longest: Math.max(0, ...ads.map((ad) => ad.daysRunning).filter(Number.isFinite)),
    }))
    .sort((a, b) => b.ads - a.ads);

  // Each advertiser's best concepts, one per concept, then the strongest overall.
  const winners: ScoredAd[] = [];
  for (const ads of byAdvertiser.values()) {
    const seen = new Set<string>();
    const best = [...ads].sort((a, b) => b.score - a.score).filter((ad) => {
      const key = ad.text || ad.headline ? conceptKey(ad.text || ad.headline) : ad.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    winners.push(...best.slice(0, 6));
  }
  winners.sort((a, b) => b.score - a.score);
  const top = winners.slice(0, 60);

  const taggable = top.filter((ad) => ad.text || ad.headline);
  const batches: ScoredAd[][] = [];
  for (let i = 0; i < taggable.length; i += 12) batches.push(taggable.slice(i, i + 12));
  await mapLimit(batches, 3, async (batch) => {
    try {
      const reply = await askJson<{ ads: Array<AdTags & { index: number }> }>({
        model: 'celeris-1',
        system: `You are a performance-marketing creative strategist who tags ads with a fixed taxonomy. ${UNTRUSTED}`,
        prompt: `Tag each ad.\n- hook: how the opening line grabs attention (${HOOKS.join(', ')})\n- angle: the specific reason it should persuade, in under 12 words\n- awareness: Eugene Schwartz stage the copy is written for (${AWARENESS.join(', ')})\n- offer: the offer if any (discount, free trial, bundle, guarantee, free shipping, none…)\n- proof: the proof used (reviews, numbers, expert, before/after, press, none…)\n- emotion: the main emotion targeted\n\n${batch.map((ad, index) => `[${index}] ${ad.advertiser}\nHeadline: ${ad.headline}\nCTA: ${ad.cta}\nCopy: ${ad.text.slice(0, 900)}`).join('\n\n')}`,
        schema: {
          type: 'object',
          properties: {
            ads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  hook: { type: 'string', enum: [...HOOKS] },
                  angle: { type: 'string' },
                  awareness: { type: 'string', enum: [...AWARENESS] },
                  offer: { type: 'string' },
                  proof: { type: 'string' },
                  emotion: { type: 'string' },
                },
              },
            },
          },
        },
        meter,
        maxTokens: 2_500,
      });
      for (const tags of reply.ads ?? []) {
        const ad = batch[tags.index];
        if (ad) ad.tags = { hook: tags.hook, angle: tags.angle, awareness: tags.awareness, offer: tags.offer, proof: tags.proof, emotion: tags.emotion };
      }
    } catch {
      // Untagged ads still rank; they just do not count toward patterns.
    }
  });

  const tally = (pickValue: (ad: ScoredAd) => string) => {
    const weights = new Map<string, { weight: number; ads: number }>();
    let total = 0;
    for (const ad of top) {
      const value = pickValue(ad).trim().toLowerCase();
      if (!value) continue;
      const entry = weights.get(value) ?? { weight: 0, ads: 0 };
      entry.weight += ad.score;
      entry.ads += 1;
      total += ad.score;
      weights.set(value, entry);
    }
    return [...weights.entries()]
      .map(([value, entry]) => ({ value, weight: total ? Number((entry.weight / total).toFixed(3)) : 0, ads: entry.ads }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);
  };

  return {
    total: scored.length,
    advertisers: advertisers.slice(0, 25),
    winners: top,
    patterns: {
      hook: tally((ad) => ad.tags?.hook ?? ''),
      awareness: tally((ad) => ad.tags?.awareness ?? ''),
      offer: tally((ad) => ad.tags?.offer ?? ''),
      proof: tally((ad) => ad.tags?.proof ?? ''),
      emotion: tally((ad) => ad.tags?.emotion ?? ''),
      cta: tally((ad) => ad.cta),
    },
    angles: top.filter((ad) => ad.tags?.angle).slice(0, 30).map((ad) => ({ angle: ad.tags!.angle, advertiser: ad.advertiser, evidenceId: ad.id })),
  };
}
