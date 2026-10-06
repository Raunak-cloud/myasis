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
}
export interface MarketingTopic {
  id: string; title: string; keyword: string; angle: string; intent: 'learn' | 'compare' | 'buy';
  priority: 'high' | 'medium'; rationale: string; productUrl: string; evidenceUrls: string[];
  basis: 'search-suggestion' | 'website-topic' | 'custom';
  status: 'planned' | 'writing' | 'drafted' | 'published' | 'dismissed'; createdAt: string;
}
export interface MarketingPost {
  id: string; topicId: string; status: 'writing' | 'draft' | 'published' | 'failed'; article: MarketingArticle | null;
  sources: MarketingSource[]; quality: { approved: boolean; issues: string[]; reviewedAt: string | null };
  model: string; publishedUrl: string | null; createdAt: string; updatedAt: string;
  metrics: { periodStart: string; periodEnd: string; visits: number | null; leads: number | null; orders: number | null; revenue: number | null; currency: string; notes: string; recordedAt: string } | null;
}
export interface MarketingJob { id: string; kind: 'research' | 'write' | 'review' | 'publish' | 'cycle'; status: 'queued' | 'running' | 'done' | 'failed'; progress: string; error: string | null; createdAt: string }
export interface MarketingWorkspace { site: MarketingSite; topics: MarketingTopic[]; posts: MarketingPost[]; jobs: MarketingJob[]; canPublish: boolean }
