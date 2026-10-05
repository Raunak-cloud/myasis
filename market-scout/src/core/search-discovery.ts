import { config } from '../config.js';
import { detectWall, dismissConsent, settle, withPage } from '../browser/session.js';
import { BlockedError, markBlocked, politely, searchEngineOf } from './politeness.js';
import type { Brief, SearchAttempt } from './types.js';

export interface SearchDiscovery { websites: string[]; queries: string[]; searches: SearchAttempt[] }
type BrowserSearchReader = (engine: 'Google' | 'Bing', url: string, deadline: number) => Promise<NonNullable<SearchAttempt['results']>>;

/** Only links actually rendered as organic results can become website leads. */
export function searchLeads(links: unknown, product = ''): string[] {
  const found: string[] = [];
  const normalize = (text: string) => text.toLowerCase().replace(/nepalese|nepali|nepal\b/g, 'nepal');
  const words = normalize(product).match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !/^(traditional|sell|selling|online|shop|store|retailer|retailers|for|and|the|with|including|australia|australian|united|states|kingdom)$/.test(w)) || [];
  for (const result of Array.isArray(links) ? links : []) {
    if (typeof result?.url !== 'string' || typeof result?.title !== 'string' || !result.title.trim()) continue;
    if (words.length && !words.some((word) => normalize(`${result.title} ${typeof result.snippet === 'string' ? result.snippet : ''}`).includes(word))) continue;
    try {
      let url = new URL(result.url);
      // Google sometimes renders an opaque /goto link. Its visible citation
      // is a public website lead, which must still pass the homepage check.
      if (/^(www\.)?google\.[a-z.]+$/.test(url.hostname) && url.pathname === '/goto') {
        if (typeof result.displayedUrl !== 'string') continue;
        url = new URL(result.displayedUrl.trim().split(/[\s›]/)[0]);
      }
      if (searchEngineOf(url.href) === 'Google Search' && url.pathname === '/url') url = new URL(url.searchParams.get('q') || url.searchParams.get('url') || '');
      if (url.hostname.replace(/^www\./, '') === 'bing.com' && url.pathname === '/ck/a') {
        const target = url.searchParams.get('u') || '';
        url = new URL(target.startsWith('a1') ? Buffer.from(target.slice(2), 'base64url').toString('utf8') : target);
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(localhost|[\d.]+)$|:|\.(local|internal|test)$/i.test(url.hostname)) continue;
      if (searchEngineOf(url.href) || /(^|\.)(google\.[a-z.]+|bing.com|microsoft.com|youtube.com|facebook.com|instagram.com|tiktok.com|pinterest.com|reddit.com)$/.test(url.hostname)) continue;
      found.push(url.origin + '/');
    } catch { /* invalid public citation */ }
  }
  return [...new Set(found)].slice(0, 8);
}

export function discoveryQueries(brief: Brief): string[] {
  const countries: Record<string, string> = { AU: 'Australia', US: 'United States', GB: 'United Kingdom', NZ: 'New Zealand', CA: 'Canada', IN: 'India', SG: 'Singapore', DE: 'Germany', FR: 'France' };
  const country = countries[brief.country] || brief.country;
  const product = (brief.niche || brief.product.split(/[,;\n]|\bincluding\b/i)[0]).trim().slice(0, 180);
  return [`${product} ${country} shop`, `${product} ${country} retailers`];
}

/** Bounded browser searches. No search APIs, guessed domains or challenge bypasses. */
export async function searchCompetitors(brief: Brief, log: (line: string) => void = () => {}, deadline = Date.now() + 100_000, readResults: BrowserSearchReader = readBrowserResults): Promise<SearchDiscovery> {
  const searches: SearchAttempt[] = [];
  const websites: string[] = [];
  const queries = discoveryQueries(brief);
  if (!config.webSearch.enabled) return { websites, queries: [], searches };
  for (const engine of ['Google', 'Bing'] as const) {
    for (const query of queries) {
      if (Date.now() >= deadline || new Set(websites).size >= 8) break;
      const url = new URL(engine === 'Google' ? 'https://www.google.com/search' : 'https://www.bing.com/search');
      url.searchParams.set('q', query);
      if (engine === 'Google') { url.searchParams.set('gl', brief.country.toLowerCase()); url.searchParams.set('hl', brief.language || 'en'); }
      else url.searchParams.set('cc', brief.country.toLowerCase());
      const attempt: SearchAttempt = { engine, query, url: url.href, status: 'error', websites: [], collectedAt: new Date().toISOString(), note: '' };
      log(`Browser search: ${engine} - ${query}`);
      try {
        const links = await readResults(engine, url.href, deadline);
        attempt.results = links;
        const leads = searchLeads(links, brief.niche || brief.product);
        attempt.websites = leads;
        attempt.status = leads.length ? 'ok' : 'empty';
        attempt.note = leads.length ? `${leads.length} public website leads read from organic results.` : 'No usable organic website links were readable; this does not establish that competitors are absent.';
        websites.push(...leads);
        log(`${engine} browser search: ${attempt.note}`);
      } catch (error) {
        attempt.status = error instanceof BlockedError ? 'blocked' : 'error';
        attempt.note = (error as Error).message.split('\n')[0].slice(0, 240);
        log(`${engine} browser search unavailable: ${attempt.note}`);
      }
      searches.push(attempt);
      if (attempt.status === 'blocked') break;
    }
  }
  return { websites: [...new Set(websites)].slice(0, 8), queries: [...new Set(searches.map((s) => s.query))], searches };
}

async function readBrowserResults(engine: 'Google' | 'Bing', url: string, deadline: number): Promise<NonNullable<SearchAttempt['results']>> {
  return withPage(async (page) => {
    await politely(url, async () => {
      if (Date.now() >= deadline) throw new Error('Browser discovery time limit reached.');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) });
      if (response && response.status() >= 400) markBlocked(url, `HTTP ${response.status()}`);
      await dismissConsent(page);
      await settle(page, Math.max(1, Math.min(3_000, deadline - Date.now())));
      const wall = await detectWall(page);
      if (wall) markBlocked(url, wall);
      if (searchEngineOf(page.url()) !== (engine === 'Google' ? 'Google Search' : 'Bing')) throw new Error('Search results redirected to an unsupported page.');
    }, { minGapMs: 3_000 });
    return page.evaluate((provider) => {
      const out: Array<{ url: string; title: string; displayedUrl: string; snippet: string }> = [];
      const nodes = provider === 'Google' ? document.querySelectorAll('a:has(h3)') : document.querySelectorAll('li.b_algo h2 a');
      for (const node of nodes) {
        const anchor = node as HTMLAnchorElement;
        if (anchor.closest('.uEierd, [data-text-ad], li.b_ad, [aria-label="Ads"]') || !anchor.getClientRects().length) continue;
        out.push({ url: anchor.href, title: (anchor.innerText || '').trim().slice(0, 300), displayedUrl: anchor.querySelector('cite')?.textContent || '', snippet: (anchor.closest(provider === 'Google' ? '.MjjYud' : 'li.b_algo') as HTMLElement | null)?.innerText.slice(0, 2_000) || '' });
      }
      return out.slice(0, 20);
    }, engine);
  });
}
