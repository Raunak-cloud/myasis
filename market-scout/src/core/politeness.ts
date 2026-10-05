import { config } from '../config.js';

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

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelaySec?: number;
}

export interface RobotsRules {
  isAllowed(path: string): boolean;
  /** Set when robots.txt itself was refused (5xx/unreachable), which RFC 9309 treats as disallow-all. */
  refusedStatus?: number;
  crawlDelayMs?: number;
  sitemaps: string[];
}

/** Parses robots.txt and selects the group for `agentToken`, falling back to `*`. */
export function parseRobots(body: string, agentToken: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelaySec = seconds;
    }
  }

  const token = agentToken.toLowerCase();
  const own = groups.filter((group) => group.agents.some((agent) => agent !== '*' && token.includes(agent)));
  const chosen = own.length ? own : groups.filter((group) => group.agents.includes('*'));
  const rules = chosen.flatMap((group) => group.rules);
  const delay = chosen.map((group) => group.crawlDelaySec).find((value) => value !== undefined);

  return {
    sitemaps,
    crawlDelayMs: delay !== undefined ? delay * 1000 : undefined,
    isAllowed(path: string) {
      // Longest matching rule wins; on a tie, Allow wins (RFC 9309 §2.2.2).
      let best: { allow: boolean; length: number } | undefined;
      for (const rule of rules) {
        if (!robotsPatternMatches(rule.pattern, path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
      }
      return best ? best.allow : true;
    },
  };
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`).test(path);
}

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
  let status = 0;
  try {
    const response = await fetch(url, { headers: { 'user-agent': botUserAgent() }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
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
 * Search-engine result pages are off limits to every browser path. Google's
 * sit behind SearchGuard, and getting around it is what the 2026 SerpApi
 * suits are about; the other engines' terms forbid automated querying too.
 * A planner once sent the agent to google.com/search, so this is enforced
 * where pages are opened, not left to prompts.
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
  if (!options.api && !(await robotsAllows(url))) throw new BlockedError(new URL(url).host, await disallowReason(url));
  return politely(url, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        body: options.body,
        headers: { 'user-agent': botUserAgent(), 'accept-language': `${config.browser.locale},en;q=0.8`, ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
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
