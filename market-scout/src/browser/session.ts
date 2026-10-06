import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'patchright';
import { config } from '../config.js';
import { parseLooseJson } from '../core/harvest.js';
import { markBlocked, OffLimitsError, politely, searchEngineOf, useBrowserFetch } from '../core/politeness.js';
import { assertPublicUrl } from '../core/public-url.js';

/**
 * The scout's one browser: a persistent, logged-out profile.
 *
 * It is never signed in to any platform. Everything it reads is what any
 * visitor sees without an account, which is both the durable legal position
 * (Meta v. Bright Data, X v. Bright Data) and what keeps one account's ban
 * from mattering.
 */

let shared: Promise<BrowserContext> | undefined;

export function browser(): Promise<BrowserContext> {
  if (shared) return shared;
  const pending = (async () => {
    const dir = resolve(config.browser.profileDir);
    mkdirSync(dir, { recursive: true });
    const proxy = config.browser.proxy ? parseProxy(config.browser.proxy) : undefined;
    const options = {
      headless: config.browser.headless,
      locale: config.browser.locale,
      timezoneId: config.browser.timezone,
      viewport: { width: 1366, height: 900 },
      proxy,
      ...(config.publicOnly ? { serviceWorkers: 'block' as const } : {}),
    };
    // An installed Chrome first (no download, and the browser sites expect); the bundled Chromium otherwise.
    const context = config.browser.chromePath
      ? await chromium.launchPersistentContext(dir, { ...options, executablePath: config.browser.chromePath })
      : await chromium
          .launchPersistentContext(dir, { ...options, channel: 'chrome' })
          .catch(() => chromium.launchPersistentContext(dir, options));
    context.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
    context.setDefaultTimeout(15_000);
    if (config.publicOnly) await context.route('**/*', async (route) => {
      try { await assertPublicUrl(route.request().url()); await route.continue(); }
      catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    return context;
  })();
  shared = pending;
  void pending.then((context) => {
    context.on('close', () => { if (shared === pending) shared = undefined; });
  }, () => { if (shared === pending) shared = undefined; });
  return pending;
}

/** robots.txt and sitemaps through a real browser tab when a CDN refuses plain clients. Not counted against page slots. */
useBrowserFetch(async (url) => {
  const context = await browser();
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return { status: response?.status() ?? 0, body: (await response?.text()) ?? '' };
  } finally {
    await page.close().catch(() => {});
  }
});

export async function closeBrowser(): Promise<void> {
  if (!shared) return;
  const context = await shared.catch(() => undefined);
  shared = undefined;
  await context?.close().catch(() => {});
}

function parseProxy(raw: string) {
  const url = new URL(raw);
  return {
    server: `${url.protocol}//${url.host}`,
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
  };
}

/** A fresh tab, closed by the caller. Bounded by the run's concurrency. */
export async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  await pageSlots.acquire();
  let page: Page | undefined;
  try {
    const context = await browser();
    page = await context.newPage();
    return await work(page);
  } finally {
    await page?.close().catch(() => {});
    pageSlots.release();
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  constructor(private free: number) {}
  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}
const pageSlots = new Semaphore(Math.max(1, config.budget.concurrency));

/** Navigates at the host's pace, then checks the page is content and not a wall. */
export async function visit(page: Page, url: string, options: { minGapMs?: number } = {}): Promise<void> {
  const engine = searchEngineOf(url);
  if (engine) throw new OffLimitsError(`${engine} result pages are off limits; open a specific site instead.`);
  const status = await politely(url, async () => (await page.goto(url, { waitUntil: 'domcontentloaded' }))?.status() ?? 0, options);
  if (status === 429) markBlocked(url, 'HTTP 429');
  await settle(page);
  await dismissConsent(page);
  const wall = await detectWall(page);
  if (wall) markBlocked(url, wall);
  // Some sites (Facebook among them) answer 403 to automated clients yet serve the full page; the content decides.
  if (status >= 400) {
    const words = await page.evaluate(() => (document.body?.innerText ?? '').split(/\s+/).length).catch(() => 0);
    if (words < 80) markBlocked(url, `HTTP ${status}`);
  }
}

/** Waits for the network to quiet down, but never long: SPAs keep sockets open. */
export async function settle(page: Page, timeoutMs = 6_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
}

/**
 * A login wall or a bot challenge, named, or "" when the page is content.
 * Either one ends the source: the scout does not sign in and does not solve
 * challenges.
 */
export async function detectWall(page: Page): Promise<string> {
  const url = page.url();
  if (/\/(login|signin|sign-in|accounts\/login|checkpoint|challenge|authwall|uas\/login)\b/i.test(new URL(url).pathname)) {
    return 'login wall';
  }
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? '').slice(0, 4_000).toLowerCase();
      const words = (document.body?.innerText ?? '').split(/\s+/).length;
      // Many sites embed an invisible reCAPTCHA or Turnstile on every page; only a visible one on a near-empty page is a challenge.
      const challengeFrame = [...document.querySelectorAll('iframe')].some((frame) => {
        const box = frame.getBoundingClientRect();
        return /recaptcha|hcaptcha|challenges\.cloudflare|arkoselabs|funcaptcha|geo\.captcha-delivery/.test(frame.src) && box.width > 60 && box.height > 60;
      });
      if (challengeFrame && words < 300) return 'CAPTCHA challenge';
      if (/verify (that )?you are (a )?human|are you a robot|unusual traffic|checking your browser|press (&|and) hold|you have been blocked|access denied|attention required/.test(text)) return 'bot challenge';
      const password = document.querySelector('input[type="password"]');
      if (password && words < 250 && /log ?in|sign ?in/.test(text)) return 'login wall';
      return '';
    })
    .catch(() => '');
}

/**
 * Closes a cookie banner, choosing "reject optional" where offered. Only
 * buttons inside something that looks like a consent dialog are considered.
 */
export async function dismissConsent(page: Page): Promise<void> {
  const choices = [
    /^(reject|decline) (all|optional)( cookies)?$/i,
    /^only allow essential cookies$/i,
    /^decline optional cookies$/i,
    /^(use|allow) (only )?(necessary|essential) cookies( only)?$/i,
    /^reject all$/i,
    /^(accept|allow) all( cookies)?$/i,
    /^(i )?(accept|agree)$/i,
  ];
  for (const pattern of choices) {
    const button = page
      .locator('[role="dialog"] button, [role="dialog"] [role="button"], [id*="consent" i] button, [class*="consent" i] button, [id*="cookie" i] button, [class*="cookie" i] button, [aria-label*="cookie" i] button')
      .filter({ hasText: pattern })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(600);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Data the page loads, rather than the pixels it paints
// ---------------------------------------------------------------------------

export interface JsonCapture {
  readonly docs: Array<{ url: string; json: unknown }>;
  /** Waits for bodies still being read, then detaches. */
  stop(): Promise<void>;
}

/**
 * Records the JSON the page fetches while it runs. On single-page apps this
 * is the platform's own typed data, more complete and far less brittle than
 * the rendered DOM.
 */
export function captureJson(page: Page, urlPattern: RegExp, maxBytes = 6_000_000): JsonCapture {
  const docs: Array<{ url: string; json: unknown }> = [];
  const pending = new Set<Promise<void>>();
  const onResponse = (response: Response) => {
    const url = response.url();
    if (!urlPattern.test(url)) return;
    const task = (async () => {
      const length = Number(response.headers()['content-length'] ?? 0);
      if (length > maxBytes) return;
      const body = await response.text().catch(() => '');
      if (!body || body.length > maxBytes) return;
      for (const json of parseLooseJson(body)) docs.push({ url, json });
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  return {
    docs,
    stop: async () => {
      page.off('response', onResponse);
      await Promise.allSettled([...pending]);
    },
  };
}

/**
 * JSON embedded in the HTML: JSON-LD, Next.js/Nuxt hydration, TikTok's
 * rehydration blob, Facebook's server-rendered `data-sjs` payloads and
 * YouTube's `ytInitialData` assignment.
 */
export async function embeddedJson(page: Page): Promise<Array<{ kind: string; json: unknown }>> {
  const raw = await page
    .evaluate(() => {
      const out: Array<{ kind: string; text: string }> = [];
      for (const script of document.querySelectorAll('script')) {
        const type = script.getAttribute('type') ?? '';
        const text = script.textContent ?? '';
        if (!text || text.length > 8_000_000) continue;
        if (type === 'application/ld+json') out.push({ kind: 'ld+json', text });
        else if (type === 'application/json') out.push({ kind: script.id || 'json', text });
        else {
          const assignment = /(?:var |window\[?["']?)(ytInitialData|ytInitialPlayerResponse|__INITIAL_STATE__|__APOLLO_STATE__)["']?\]?\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text.trim());
          if (assignment) out.push({ kind: assignment[1], text: assignment[2] });
        }
      }
      return out;
    })
    .catch(() => [] as Array<{ kind: string; text: string }>);
  const parsed: Array<{ kind: string; json: unknown }> = [];
  for (const item of raw) {
    try {
      parsed.push({ kind: item.kind, json: JSON.parse(item.text) });
    } catch {
      // Some "json" scripts are templates or JS; skip them.
    }
  }
  return parsed;
}

/**
 * Scrolls until `count()` stops growing (or the page stops getting taller),
 * the way a reader pages through a feed. Returns the final count.
 */
export async function scrollToLoad(page: Page, options: { maxScrolls: number; target: number; count: () => Promise<number> | number }): Promise<number> {
  const height = () => page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  let current = await options.count();
  let lastCount = current;
  let lastHeight = await height();
  let flat = 0;
  for (let i = 0; i < options.maxScrolls && current < options.target; i++) {
    await page.mouse.wheel(0, 2_400).catch(() => {});
    await page.waitForTimeout(1_200 + Math.random() * 900);
    await settle(page, 2_500);
    current = await options.count();
    const nowHeight = await height();
    // Two scrolls that neither load items nor lengthen the page: the feed has ended.
    flat = current === lastCount && nowHeight === lastHeight ? flat + 1 : 0;
    if (flat >= 2) break;
    lastCount = current;
    lastHeight = nowHeight;
  }
  return current;
}
