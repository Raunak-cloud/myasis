export interface MarketingArticle {
  title: string; slug: string; metaDescription: string; focusKeyword: string; targetSearches: string[];
  lead: string; sections: Array<{ heading: string; paragraphs: string[]; bullets: string[] }>; takeaways: string[];
}
export interface MarketingSource { ref: string; publisher: string; title: string; url: string; published: string | null; excerpt: string; collectedAt: string; role: 'own' | 'competitor' }
export interface WebsitePage {
  url: string; title: string; text: string; description: string; h1: string[]; ctas: string[];
  links: Array<{ text: string; href: string }>;
  products: Array<{ name: string; price: string; currency: string; availability: string; url: string; priceBasis: string }>;
}
export interface WebsiteProfile {
  name: string; sells: string; suggestedAudience: string; scannedAt: string; pages: WebsitePage[];
  productQuotes: Array<{ url: string; quote: string }>; gaps: string[];
}
export interface MarketingResearch {
  researchedAt: string; sources: MarketingSource[];
  keywords: Array<{ phrase: string; engines: string[]; evidenceUrls: string[] }>;
  competitors: Array<{ name: string; website: string; region: string; productQuote: string }>;
  searches: Array<{ engine: string; query: string; status: string; leads: number }>;
  gaps: string[]; cost: string; collected: number; retained: number;
  auditActions: Array<{ url: string; issue: string; action: string }>;
}
export interface MarketingSite {
  id: string; url: string; name: string; country: string; profile: WebsiteProfile | null; research: MarketingResearch | null;
  voice: string; audience: string; ctaLabel: string; ctaUrl: string; profileConfirmed: boolean;
  publisher: 'owtomate' | 'export'; scheduleEnabled: boolean; publishMode: 'review' | 'auto';
  scheduleDay: number; scheduleTime: string; timezone: string; nextRunAt: string | null; ownsBlogSchedule: boolean;
  createdAt: string; updatedAt: string;
  health?: WebsiteHealth | null;
  growthGoal?: 'traffic' | 'leads' | 'sales';
  growthAIProvider?: 'off' | 'ChatGPT' | 'Perplexity';
}
export interface MarketingTopic {
  id: string; title: string; keyword: string; angle: string; intent: 'learn' | 'compare' | 'buy';
  priority: 'high' | 'medium'; rationale: string; productUrl: string; evidenceUrls: string[];
  basis: 'search-suggestion' | 'website-topic' | 'custom';
  status: 'planned' | 'writing' | 'drafted' | 'published' | 'dismissed'; createdAt: string;
}
export interface MarketingPost {
  handledAt?: string | null;
  id: string; topicId: string; status: 'writing' | 'draft' | 'published' | 'failed'; article: MarketingArticle | null;
  sources: MarketingSource[]; quality: { approved: boolean; issues: string[]; reviewedAt: string | null };
  model: string; publishedUrl: string | null; createdAt: string; updatedAt: string;
  metrics: { periodStart: string; periodEnd: string; visits: number | null; leads: number | null; orders: number | null; revenue: number | null; currency: string; notes: string; recordedAt: string } | null;
}
export interface MarketingJob { id: string; kind: 'research' | 'write' | 'review' | 'publish' | 'cycle' | 'growth' | 'health' | 'visibility' | 'results'; status: 'queued' | 'running' | 'done' | 'failed'; progress: string; error: string | null; createdAt: string; growthRun?: GrowthRun }
export interface GrowthStep {
  key: 'results' | 'health' | 'research' | 'visibility' | 'strategy' | 'content';
  title: string; status: 'pending' | 'running' | 'done' | 'attention' | 'skipped'; summary: string; finishedAt: string | null;
}
export interface GrowthRun { startedAt:string; completedAt:string|null; steps:GrowthStep[] }
export interface HealthPage {
  url: string; requestedUrl: string; status: number | null; title: string; description: string; canonical: string;
  robotsMeta: string; xRobotsTag: string; h1: string[]; wordCount: number; text: string; links: Array<{text:string;href:string}>;
  jsonLdTypes: string[]; invalidJsonLd: number; imagesWithoutAlt: number; lang: string; error: string | null;
}
export interface HealthFinding { id: string; severity: 'urgent' | 'improvement'; title: string; url: string; evidence: string; action: string }
export interface WebsiteHealth {
  checkedAt: string; pages: HealthPage[]; findings: HealthFinding[]; gaps: string[];
  robots: { url: string; status: number | null; body: string | null };
  sitemaps: Array<{url:string;status:number|null;urls:string[];error:string|null}>;
  crawlerAccess: Array<{bot:string;allowed:number;blocked:number;unknown:number}>;
}
export interface ContentAction {
  id: string; kind: 'fix' | 'refresh' | 'link' | 'new'; title: string; reason: string; url: string; targetUrl?: string;
  evidenceUrls: string[]; priority: 'high' | 'medium'; status: 'open' | 'done' | 'dismissed'; topicId?: string;
}
export interface OrganicStrategy { generatedAt:string; actions:ContentAction[]; clusters:Array<{name:string;topics:string[]}>; limits:string[] }
export interface AIObservation {
  id:string; provider:'ChatGPT'|'Perplexity'|'Gemini'|'Claude'|'Copilot'; prompt:string; country:string; observedAt:string;
  status:'complete'|'blocked'|'unavailable'; method:'browser'|'recorded'; answer:string; citations:string[];
  responseUrl:string|null; mentioned:boolean|null; cited:boolean|null; recommendationQuote:string|null;
  model:string; note:string; fingerprint:string;
}
export interface ResultsSnapshot {
  id:string; source:'search-console'|'ga4'|'manual'; method:'api'|'import'|'recorded'; sourceLabel:string;
  periodStart:string; periodEnd:string; timezone:string; recordedAt:string;
  clicks:number|null; impressions:number|null; ctr:number|null; position:number|null;
  sessions:number|null; organicSessions:number|null; aiSessions:number|null; keyEvents:number|null;
  leads:number|null; orders:number|null; revenue:number|null; currency:string|null;
  pages:Array<{url:string;clicks:number;impressions:number;ctr:number;position:number|null}>;
  queries:Array<{query:string;clicks:number;impressions:number}>;
  channels:Array<{name:string;sessions:number}>; aiSources:Array<{name:string;sessions:number}>;
  notes:string[]; previous:{clicks?:number;sessions?:number;organicSessions?:number}|null;
}
export interface MarketingGrowth {
  strategy:OrganicStrategy; observations:AIObservation[]; prompts:string[]; results:ResultsSnapshot[];
  connection:{connected:boolean;configured:boolean;searchProperty:string|null;gaProperty:string|null;dailySync:boolean;lastSyncAt:string|null;error:string|null;redirectUri:string};
}
export interface MarketingWorkspace { site: MarketingSite; topics: MarketingTopic[]; posts: MarketingPost[]; jobs: MarketingJob[]; canPublish: boolean; growth?:MarketingGrowth }
