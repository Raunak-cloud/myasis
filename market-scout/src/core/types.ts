/**
 * The shared vocabulary: what a research brief asks for, and the one shape
 * every source writes its findings in. Analyzers and the report read only
 * `Evidence`, so a new source needs no change anywhere downstream.
 */

export type SourceId =
  | 'reddit'
  | 'meta-ads'
  | 'tiktok-creative'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'youtube'
  | 'google-ads'
  | 'linkedin-ads'
  | 'autocomplete'
  | 'trends'
  | 'website'
  | 'agent';

export type EvidenceKind =
  | 'ad'
  | 'post'
  | 'comment'
  | 'video'
  | 'profile'
  | 'keyword'
  | 'question'
  | 'page'
  | 'hashtag'
  | 'trend';

export interface Evidence {
  /** Stable across runs: the same item collected twice is one record. */
  id: string;
  source: SourceId;
  kind: EvidenceKind;
  url: string;
  title: string;
  text: string;
  author: string;
  /** ISO date when the platform states one, else "". */
  publishedAt: string;
  /** Numbers the platform shows: likes, comments, views, shares, followers, daysRunning, variants, rank… */
  metrics: Record<string, number>;
  /** Platform-specific facts: cta, landingUrl, hashtags, subreddit, platforms, intent… */
  attributes: Record<string, string | string[]>;
  /** The query or task that surfaced it. */
  query: string;
  collectedAt: string;
}

export interface Brief {
  /** Discover missing research context from the product before planning. */
  autoDiscover?: boolean;
  discovery?: MarketDiscovery;
  /** What is being marketed, in a sentence. */
  product: string;
  /** The niche or category, used to seed searches. */
  niche: string;
  brand: string;
  /** Optional user-owned site, separate from competitor comparisons. */
  ownWebsite?: string;
  competitors: string[];
  /** Competitor or own sites to audit. */
  websites: string[];
  /** ISO country code for ad libraries, autocomplete and trends. */
  country: string;
  language: string;
  audience: string;
  /** Free-form goals: "find hooks that work for X", "SEO keywords for Y". */
  goals: string[];
  /** Restrict to these sources; empty means let the planner choose. */
  sources: SourceId[];
}

export interface MarketDiscovery {
  searchQueries?: string[];
  audienceBasis: 'suggested' | 'provided';
  categoryBasis: 'suggested' | 'provided';
  competitors: Array<{ name: string; website: string; evidenceId: string; productQuote: string; marketQuote: string; region: 'target' | 'unknown' }>;
  notes: string[];
}

/** One unit of collection work, produced by the planner and run by a source. */
export interface Task {
  source: SourceId;
  /** The search phrase, page name, URL or instruction. */
  query: string;
  /** How many items are worth collecting. */
  limit: number;
  why: string;
}

export interface TaskResult {
  task: Task;
  ok: boolean;
  count: number;
  /** Why nothing came back, in a sentence a user understands. */
  note: string;
  ms: number;
}
