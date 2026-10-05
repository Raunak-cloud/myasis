import { config } from '../config.js';
import type { Brief } from './types.js';
import type { CostMeter } from '../llm/celeris.js';

export interface SearchDiscovery { websites: string[]; queries: string[] }

/** Website leads come from search result URLs, never model prose. */
export function searchLeads(payload: unknown): string[] {
  const data = payload as { web?: { results?: Array<{ url?: unknown }> } };
  const found: string[] = [];
  for (const result of Array.isArray(data?.web?.results) ? data.web.results : []) {
    if (typeof result?.url !== 'string') continue;
    try {
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(localhost|[\d.]+)$|:|\.(local|internal|test)$/i.test(url.hostname)) continue;
      found.push(url.origin + '/');
    } catch { /* invalid public citation */ }
  }
  return [...new Set(found)].slice(0, 8);
}

export async function searchCompetitors(brief: Brief, meter: CostMeter): Promise<SearchDiscovery | undefined> {
  if (!config.webSearch.enabled || !config.webSearch.apiKey || meter.remainingUsd < 0.01) return;
  const query = `${brief.product.slice(0, 400)} retailers ${brief.country}`;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '8');
  url.searchParams.set('country', brief.country === 'UK' ? 'GB' : brief.country);
  const response = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': config.webSearch.apiKey }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(response.status === 429 ? 'Live web search is unavailable: search-provider quota or rate limit reached.' : `Live web search unavailable (HTTP ${response.status}).`);
  meter.recordExternalEstimate(0.01);
  const websites = searchLeads(await response.json());
  if (!websites.length) throw new Error('Live web search returned no usable public website leads.');
  return { websites, queries: [query] };
}
