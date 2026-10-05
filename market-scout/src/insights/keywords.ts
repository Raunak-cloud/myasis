import type { Brief, Evidence } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit } from '../llm/extract.js';

/**
 * SEO keywords from autocomplete (and trend) evidence.
 *
 * Deterministic first: phrases are merged across engines, given an intent
 * from their modifiers, and scored on demand signals. Magnus then groups them
 * into topic clusters, one page each — but may only use phrases it was given;
 * anything it invents is dropped, anything it leaves out is kept.
 *
 * What this cannot measure without a licensed SERP feed: difficulty. The
 * report says so rather than guessing.
 */

export type Intent = 'informational' | 'commercial' | 'transactional' | 'navigational';

export interface Keyword {
  phrase: string;
  intent: Intent;
  engines: string[];
  bestRank: number;
  words: number;
  isQuestion: boolean;
  /** 0-100. Engine agreement and suggestion rank: a proxy for relative demand, not volume. */
  demand: number;
  evidenceIds: string[];
}

export interface KeywordCluster {
  name: string;
  intent: Intent;
  pageIdea: string;
  format: string;
  keywords: string[];
  /** Sum of member demand × intent value; ranks clusters against each other only. */
  opportunity: number;
}

export interface KeywordInsights {
  total: number;
  questions: string[];
  topKeywords: Keyword[];
  clusters: KeywordCluster[];
  trends: Array<{ keyword: string; growth: string; evidenceId: string }>;
}

const INTENT_RULES: Array<{ intent: Intent; pattern: RegExp }> = [
  { intent: 'transactional', pattern: /\b(buy|price|prices|pricing|cost|cheap|discount|coupon|promo|deal|deals|order|for sale|near me|shop|delivery|subscription|free trial|sign up|download)\b/ },
  { intent: 'commercial', pattern: /\b(best|top|review|reviews|vs|versus|alternative|alternatives|compare|comparison|worth it|like|rated|recommend)\b/ },
  { intent: 'informational', pattern: /^(how|what|why|which|where|when|who|can|is|are|does|should)\b|\b(guide|tutorial|ideas|tips|examples|meaning|benefits|reddit)\b/ },
];

const INTENT_VALUE: Record<Intent, number> = { transactional: 1, commercial: 0.9, informational: 0.5, navigational: 0.3 };

export function classifyIntent(phrase: string, brandNames: string[]): Intent {
  const text = phrase.toLowerCase();
  if (brandNames.some((name) => name && new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))) {
    // A brand plus a comparison word is a comparison, not a visit.
    return /\b(vs|versus|alternative|review|compare)\b/.test(text) ? 'commercial' : 'navigational';
  }
  return INTENT_RULES.find((rule) => rule.pattern.test(text))?.intent ?? 'informational';
}

export function mergeKeywords(items: Evidence[], brandNames: string[]): Keyword[] {
  const byPhrase = new Map<string, Keyword>();
  for (const item of items) {
    if (item.source !== 'autocomplete') continue;
    const phrase = item.text.trim().toLowerCase();
    const rank = item.metrics.rank ?? 10;
    const engine = String(item.attributes.engine ?? '');
    const known = byPhrase.get(phrase);
    if (known) {
      if (engine && !known.engines.includes(engine)) known.engines.push(engine);
      known.bestRank = Math.min(known.bestRank, rank);
      known.evidenceIds.push(item.id);
      continue;
    }
    byPhrase.set(phrase, {
      phrase,
      intent: classifyIntent(phrase, brandNames),
      engines: engine ? [engine] : [],
      bestRank: rank,
      words: phrase.split(/\s+/).length,
      isQuestion: item.kind === 'question',
      demand: 0,
      evidenceIds: [item.id],
    });
  }
  for (const keyword of byPhrase.values()) {
    // Agreement across engines counts most; a top suggestion slot counts next.
    keyword.demand = Math.round(Math.min(1, keyword.engines.length / 3) * 60 + ((11 - Math.min(10, keyword.bestRank)) / 10) * 40);
  }
  return [...byPhrase.values()].sort((a, b) => b.demand - a.demand || a.words - b.words);
}

export async function analyzeKeywords(all: Evidence[], brief: Brief, meter: CostMeter): Promise<KeywordInsights> {
  const keywords = mergeKeywords(all, [brief.brand, ...brief.competitors]);
  const trends = all
    .filter((item) => item.kind === 'trend')
    .map((item) => ({
      keyword: item.title,
      growth: ['growthWoW', 'growthMoM', 'growthYoY', 'rankChange']
        .filter((key) => Number.isFinite(item.metrics[key]))
        .map((key) => `${key.replace('growth', '')} ${item.metrics[key] > 0 ? '+' : ''}${item.metrics[key]}%`)
        .join(', '),
      evidenceId: item.id,
    }));
  if (!keywords.length) return { total: 0, questions: [], topKeywords: [], clusters: [], trends };

  const clusters = await clusterKeywords(keywords.slice(0, 600), brief, meter);


  return {
    total: keywords.length,
    questions: keywords.filter((keyword) => keyword.isQuestion).slice(0, 60).map((keyword) => keyword.phrase),
    topKeywords: keywords.slice(0, 80),
    clusters,
    trends,
  };
}

/**
 * Clustering in two steps, because it is two different jobs:
 *  1. Magnus decides what the clusters are, from the strongest phrases — a
 *     small, judgement-heavy answer.
 *  2. celeris-1 files every phrase under one cluster in batches — plain
 *     classification, by number.
 * Asking Magnus to do both in one reply spent 9,000 reasoning tokens walking
 * the list phrase by phrase and still ran out of room.
 */
async function clusterKeywords(pool: Keyword[], brief: Brief, meter: CostMeter): Promise<KeywordCluster[]> {
  let defined: Array<{ name: string; intent: Intent; pageIdea: string; format: string; covers: string }>;
  try {
    const reply = await askJson<{ clusters: typeof defined }>({
      model: 'celeris-1-magnus',
      system: 'You are an SEO strategist. A cluster is a set of searches that one page could rank for: same topic, same searcher intent.',
      prompt: `Business: ${brief.product} (${brief.niche}); audience: ${brief.audience || 'not stated'}.\nFrom these search phrases, define 6-18 clusters relevant to the business. For each: a short name, the dominant intent, the page that should target it (pageIdea), its best format (guide, comparison, listicle, landing page, product page, tool, FAQ, video), and one line on which searches belong in it (covers).\n\n${pool.slice(0, 200).map((keyword) => keyword.phrase).join('\n')}`,
      schema: {
        type: 'object',
        properties: {
          clusters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                intent: { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] },
                pageIdea: { type: 'string' },
                format: { type: 'string' },
                covers: { type: 'string' },
              },
            },
          },
        },
      },
      meter,
      effort: 'low',
      maxTokens: 2_000,
    });
    defined = (reply.clusters ?? []).slice(0, 18);
  } catch {
    return [];
  }
  if (!defined.length) return [];

  const members = defined.map(() => [] as Keyword[]);
  const batches: Keyword[][] = [];
  for (let i = 0; i < pool.length; i += 120) batches.push(pool.slice(i, i + 120));
  const legend = defined.map((cluster, index) => `${index}. ${cluster.name} — ${cluster.covers}`).join('\n');
  await mapLimit(batches, 3, async (batch) => {
    try {
      const reply = await askJson<{ assignments: Array<{ phrase: number; cluster: number }> }>({
        model: 'celeris-1',
        system: 'You file search phrases under SEO clusters. Answer with numbers only.',
        prompt: `Clusters:\n${legend}\n\nFor each phrase below, give its number and the number of the one cluster it belongs to, or -1 if none fits or it is irrelevant to ${brief.niche || brief.product}.\n\n${batch.map((keyword, index) => `${index}. ${keyword.phrase}`).join('\n')}`,
        schema: {
          type: 'object',
          properties: { assignments: { type: 'array', items: { type: 'object', properties: { phrase: { type: 'integer' }, cluster: { type: 'integer' } } } } },
        },
        meter,
        maxTokens: 4_000,
      });
      const seen = new Set<number>();
      for (const { phrase, cluster } of reply.assignments ?? []) {
        if (!batch[phrase] || !members[cluster] || seen.has(phrase)) continue;
        seen.add(phrase);
        members[cluster].push(batch[phrase]);
      }
    } catch {
      // An unfiled batch leaves its phrases out of clusters, nothing worse.
    }
  });

  return defined
    .map(({ covers: _covers, ...cluster }, index) => ({
      ...cluster,
      keywords: members[index].sort((a, b) => b.demand - a.demand).map((keyword) => keyword.phrase),
      opportunity: Math.round(members[index].reduce((sum, keyword) => sum + keyword.demand * INTENT_VALUE[keyword.intent], 0)),
    }))
    .filter((cluster) => cluster.keywords.length > 0)
    .sort((a, b) => b.opportunity - a.opportunity);
}
