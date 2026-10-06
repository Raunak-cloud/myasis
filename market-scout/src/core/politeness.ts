import { config } from '../config.js';
import { assertPublicUrl, publicFetch } from './public-url.js';

/**
 * How the scout behaves as a guest on other people's servers.
 *
 *  - One request at a time per host, at least `perHostDelayMs` apart (or the
 *    site's Crawl-delay, if longer).
 *  - robots.txt (RFC 9309) is obeyed by everything that *discovers* URLs —
 *    the site crawler and link following.
 *  - A block is a stop signal. A 403/429, a login wall or a challenge page
 *    ends that source for the run; nothing here rotates identities, solves
 *    CAPTCHAs or retries around a refusal. Circumventing those measures is
 *    exactly the conduct the 2026 DMCA scraping cases turn on.
 */

export class BlockedError extends Error {
  constructor(readonly host: string, reason: string) {
    super(`${host} refused automated access (${reason}); stopping this source for the run.`);
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

import { parseRobots, type RobotsRules } from './robots.js';
export { parseRobots, type RobotsRules } from './robots.js';

// ---------------------------------------------------------------------------
// Per-host gate
// ---------------------------------------------------------------------------

const robotsCache = new Map<string, Promise<RobotsRules>>();
const hostQueues = new Map<string, Promise<void>>();
const lastHit = new Map<string, number>();
const blockedHosts = new Map<string, string>();

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, sitemaps: [] };

type TextFetch = (url: string) => Promise<{ status: number; body: string }>;
let browserFetch: TextFetch | undefined;

/**
 * Lets plain-text fetches (robots.txt, sitemaps) fall back to the real
 * browser. CDNs such as Akamai answer 403/503 to any non-browser TLS client,
 * even for robots.txt — and a robots.txt we cannot read must be treated as
 * "disallow everything", which would wrongly shut out the whole site.
 */
export function useBrowserFetch(fetcher: TextFetch): void {
  browserFetch = fetcher;
}

/** GET a text resource; when the server refuses a non-browser client, ask the browser instead. */
export async function fetchText(url: string): Promise<{ status: number; body: string }> {
  if (config.publicOnly) await assertPublicUrl(url);
  let status = 0;
  try {
    const response = config.publicOnly ? await publicFetch(url,{headers:{'user-agent':botUserAgent()}}) : await fetch(url, { headers: { 'user-agent': botUserAgent() }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    status = response.status;
    if (response.ok) return { status, body: await response.text() };
  } catch {
    status = 0;
  }
  if ((status === 0 || status === 403 || status >= 500) && browserFetch) {
    try {
      return await browserFetch(url);
    } catch {
      // Keep the original status.
    }
  }
  return { status, body: '' };
}

export function robotsFor(origin: string): Promise<RobotsRules> {
  let cached = robotsCache.get(origin);
  if (!cached) {
    cached = fetchText(`${origin}/robots.txt`).then(({ status, body }) => {
      // RFC 9309: 4xx means no restrictions; 5xx or unreachable means assume full disallow.
      if (status >= 400 && status < 500) return ALLOW_ALL;
      if (status < 200 || status >= 300) return { ...parseRobots('User-agent: *\nDisallow: /', config.politeness.userAgentToken), refusedStatus: status };
      return parseRobots(body, config.politeness.userAgentToken);
    });
    robotsCache.set(origin, cached);
  }
  return cached;
}

/** Why robots.txt stops `url`: a rule, or a site that would not even serve robots.txt. */
export async function disallowReason(url: string): Promise<string> {
  const rules = await robotsFor(new URL(url).origin);
  return rules.refusedStatus !== undefined
    ? `the site refuses automated clients — even robots.txt answered ${rules.refusedStatus || 'nothing'}`
    : 'robots.txt disallows this path';
}

export async function robotsAllows(url: string): Promise<boolean> {
  if (!config.politeness.respectRobots) return true;
  const parsed = new URL(url);
  const rules = await robotsFor(parsed.origin);
  return rules.isAllowed(parsed.pathname + parsed.search);
}

/**
 * Runs `work` when this host's turn comes: serial per host, spaced by the
 * configured delay or the site's Crawl-delay. Different hosts run in parallel.
 */
export async function politely<T>(url: string, work: () => Promise<T>, options: { minGapMs?: number } = {}): Promise<T> {
  const host = new URL(url).host;
  const blocked = blockedHosts.get(host);
  if (blocked) throw new BlockedError(host, blocked);

  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  hostQueues.set(host, previous.then(() => mine));
  await previous;
  try {
    const robots = config.politeness.respectRobots ? await robotsFor(new URL(url).origin) : ALLOW_ALL;
    const gap = Math.max(options.minGapMs ?? config.politeness.perHostDelayMs, robots.crawlDelayMs ?? 0);
    const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + Math.random() * 400));
    lastHit.set(host, Date.now());
    return await work();
  } finally {
    release();
  }
}

/** Records a refusal so every later request to the host stops at once. */
export function markBlocked(url: string, reason: string): never {
  const host = new URL(url).host;
  blockedHosts.set(host, reason);
  throw new BlockedError(host, reason);
}

export function isBlocked(url: string): boolean {
  return blockedHosts.has(new URL(url).host);
}

/**
 * Recognize search pages. Only the bounded browser-discovery collector opens
 * them; generic crawler/agent tasks still open specific sites. A challenge
 * stops the engine, and is never solved or bypassed.
 */
export function searchEngineOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname;
  if (/^google\.[a-z.]+$/.test(host) && /^\/(search|webhp|url)/.test(path)) return 'Google Search';
  if (host === 'bing.com' && path.startsWith('/search')) return 'Bing';
  if (host.endsWith('duckduckgo.com')) return 'DuckDuckGo';
  if (host === 'search.yahoo.com') return 'Yahoo Search';
  if (host === 'search.brave.com') return 'Brave Search';
  if (/^yandex\.[a-z.]+$/.test(host) && path.startsWith('/search')) return 'Yandex';
  if (host === 'baidu.com' && path === '/s') return 'Baidu';
  if (host === 'ecosia.org' && path.startsWith('/search')) return 'Ecosia';
  if (host.endsWith('startpage.com')) return 'Startpage';
  return '';
}

export class OffLimitsError extends Error {}

export function botUserAgent(): string {
  return `Mozilla/5.0 (compatible; ${config.politeness.userAgentToken}/1.0; marketing research)`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Official APIs are not crawled pages; robots.txt does not govern them. */
  api?: boolean;
  minGapMs?: number;
  timeoutMs?: number;
}

/** A polite GET/POST: robots-checked (unless an API), host-paced, stops on refusal. */
export async function http(url: string, options: HttpOptions = {}): Promise<Response> {
  if (config.publicOnly) await assertPublicUrl(url);
  if (!options.api && !(await robotsAllows(url))) throw new BlockedError(new URL(url).host, await disallowReason(url));
  return politely(url, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fetchOptions = {
        method: options.method ?? 'GET',
        body: options.body,
        headers: { 'user-agent': botUserAgent(), 'accept-language': `${config.browser.locale},en;q=0.8`, ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      };
      const response = config.publicOnly ? await publicFetch(url,{method:fetchOptions.method,body:fetchOptions.body,headers:fetchOptions.headers,timeoutMs:options.timeoutMs}) : await fetch(url,fetchOptions);
      if (response.status === 429 || response.status === 503) {
        // One wait for an explicit Retry-After; a second refusal is a block.
        const retryAfter = Number(response.headers.get('retry-after'));
        if (attempt === 0 && Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        markBlocked(url, `HTTP ${response.status}`);
      }
      if (response.status === 403 && !options.api) markBlocked(url, 'HTTP 403');
      return response;
    }
    markBlocked(url, 'rate limited');
  }, { minGapMs: options.minGapMs });
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await http(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}
