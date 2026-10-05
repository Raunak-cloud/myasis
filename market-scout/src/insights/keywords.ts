import type { Brief, Evidence } from '../core/types.js';
import { type CostMeter } from '../llm/celeris.js';

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

  // Public reports use exact phrases; avoid unused speculative clustering.
  const clusters: KeywordCluster[] = [];


  return {
    total: keywords.length,
    questions: keywords.filter((keyword) => keyword.isQuestion).slice(0, 60).map((keyword) => keyword.phrase),
    topKeywords: keywords.slice(0, 80),
    clusters,
    trends,
  };
}
