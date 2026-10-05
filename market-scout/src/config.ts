import 'dotenv/config';

/**
 * Every knob in one place, read once from the environment.
 *
 * Optional credentials switch a source from its browser path to its official
 * API path; nothing here is required except CELERIS_API_KEY.
 */

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name]?.trim() ? value : fallback;
};
const str = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();
const bool = (name: string, fallback: boolean) => {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw ? raw === 'true' || raw === '1' : fallback;
};

export const config = {
  webSearch: { enabled: bool('SCOUT_WEB_SEARCH', true) },
  celeris: {
    apiKey: str('CELERIS_API_KEY'),
    /** Root only: the model id is a path segment Celeris derives per request. */
    baseUrl: str('CELERIS_BASE_URL', 'https://inference.celeris.ai'),
    timeoutMs: num('CELERIS_TIMEOUT_MS', 90_000),
    /** Celeris stops at 2,048 when none is sent; Magnus' reasoning counts against it. */
    maxOutputTokens: num('CELERIS_MAX_OUTPUT_TOKENS', 8_192),
  },

  /** A research run has no natural end; these bound it. */
  budget: {
    usd: num('SCOUT_BUDGET_USD', 1.5),
    maxMs: num('SCOUT_MAX_MS', 30 * 60_000),
    concurrency: num('SCOUT_CONCURRENCY', 3),
  },

  agent: {
    maxSteps: num('AGENT_MAX_STEPS', 30),
    escalateAfterStalls: num('AGENT_ESCALATE_AFTER', 2),
    screenshots: bool('AGENT_SCREENSHOTS', true),
    maxTranscriptTokens: num('AGENT_MAX_TRANSCRIPT_TOKENS', 60_000),
  },

  browser: {
    /**
     * A normal (headed) window by default. Headless Chrome announces itself in
     * its user agent, and Cloudflare-fronted sites such as LinkedIn refuse it
     * outright; the scout does not disguise itself, so it runs as an ordinary
     * browser instead (on a server, inside a virtual display such as Xvfb).
     */
    headless: bool('HEADLESS', false),
    /** A persistent profile keeps cookie consent choices between runs. Never a signed-in personal profile. */
    profileDir: str('SCOUT_PROFILE_DIR', '.scout/profile'),
    chromePath: str('CHROME_PATH'),
    /** e.g. http://user:pass@host:port — applied to the browser and to HTTP sources. */
    proxy: str('SCOUT_PROXY'),
    locale: str('SCOUT_LOCALE', 'en-AU'),
    timezone: str('SCOUT_TIMEZONE', 'Australia/Sydney'),
    navigationTimeoutMs: num('NAV_TIMEOUT_MS', 45_000),
  },

  politeness: {
    /** Minimum gap between two requests to the same host. */
    perHostDelayMs: num('PER_HOST_DELAY_MS', 2_500),
    respectRobots: bool('RESPECT_ROBOTS', true),
    userAgentToken: str('SCOUT_UA_TOKEN', 'MarketScout'),
  },

  /** Optional official-API credentials. Each one upgrades its source from browser to API. */
  apis: {
    metaAccessToken: str('META_AD_LIBRARY_TOKEN'),
    /** Instagram Graph API: your own Business/Creator account id and its token, for business_discovery. */
    instagramBusinessId: str('INSTAGRAM_BUSINESS_ID'),
    instagramToken: str('INSTAGRAM_ACCESS_TOKEN'),
    pinterestToken: str('PINTEREST_ACCESS_TOKEN'),
    youtubeKey: str('YOUTUBE_API_KEY'),
    redditClientId: str('REDDIT_CLIENT_ID'),
    redditClientSecret: str('REDDIT_CLIENT_SECRET'),
    /** Reddit asks for "<platform>:<app id>:<version> (by /u/<username>)". */
    redditUserAgent: str('REDDIT_USER_AGENT', 'node:market-scout:1.0 (by /u/market-scout)'),
  },

  dataDir: str('SCOUT_DATA_DIR', '.scout'),
};

export type Config = typeof config;
