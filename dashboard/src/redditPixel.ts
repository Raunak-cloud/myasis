/**
 * Reddit Pixel — the browser half of conversion tracking.
 *
 * `server/reddit-capi.ts` reports the same conversions from the server, and
 * Reddit keeps one of each pair by matching `conversionId`. Both halves must
 * therefore derive the id the same way from the same facts; anything random
 * generated here would never match its twin and every conversion would count
 * twice. The ids come from rows that already exist — a user id, a purchase id.
 *
 * Two things the server cannot know are collected here and left where it can
 * read them, both as first-party cookies on our own domain:
 *
 *   `_rdt_uuid`        set by Reddit's script, their preferred match key
 *   `owtomate_rdt_cid` the ad click id, which arrives once as a query
 *                      parameter on the landing URL and is gone after the
 *                      first in-app navigation unless it is kept
 *
 * Off unless a pixel id was configured at build time, and never loaded for an
 * automated browser — `src/analytics.ts` makes the same call, for the same
 * reason: a scanner is not a visitor, and the bot's own Chrome must not report
 * conversions for the person it is applying on behalf of.
 */

declare const __REDDIT_PIXEL_ID__: string;

declare global {
  interface Window {
    rdt?: ((...args: unknown[]) => void) & { callQueue?: unknown[]; sendEvent?: unknown };
  }
}

const CLICK_ID_PARAM = 'rdt_cid';
const CLICK_ID_COOKIE = 'owtomate_rdt_cid';
/** Reddit's attribution window is 28 days; keeping the click id longer only ages it. */
const CLICK_ID_DAYS = 28;

export type RedditEvent =
  | 'PageVisit'
  | 'ViewContent'
  | 'Search'
  | 'AddToCart'
  | 'AddToWishlist'
  | 'Lead'
  | 'SignUp'
  | 'Purchase';

export interface RedditEventOptions {
  /** Must equal the id the server sends for the same event, or it will not deduplicate. */
  conversionId?: string;
  currency?: string;
  value?: number;
  itemCount?: number;
}

const pixelId = typeof __REDDIT_PIXEL_ID__ === 'string' ? __REDDIT_PIXEL_ID__.trim() : '';

/**
 * A seam for a consent banner. Nothing calls it yet — the privacy policy
 * discloses the pixel instead — but when a banner arrives it sets this to
 * false before anything loads, and no request leaves the page.
 */
let allowed = true;
export function setRedditConsent(next: boolean): void {
  allowed = next;
}

function enabled(): boolean {
  if (!pixelId || !allowed) return false;
  // A browser under automation says so; the bot's Chrome must not be counted.
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  return true;
}

function writeCookie(name: string, value: string, days: number): void {
  try {
    const expires = new Date(Date.now() + days * 86_400_000).toUTCString();
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Expires=${expires}; SameSite=Lax${secure}`;
  } catch {
    // A blocked cookie jar costs attribution quality, never a working page.
  }
}

/**
 * Keeps the ad click id past the first navigation. Written to a cookie rather
 * than storage so the server can read it on the OAuth callback and the Stripe
 * return, neither of which runs our JavaScript.
 */
function captureClickId(): void {
  try {
    const clickId = new URLSearchParams(location.search).get(CLICK_ID_PARAM);
    if (clickId) writeCookie(CLICK_ID_COOKIE, clickId, CLICK_ID_DAYS);
  } catch {
    // Ignored: a malformed URL is not worth a broken page load.
  }
}

let loaded = false;

/** Injects Reddit's script and reports the first page. Safe to call more than once. */
export function initRedditPixel(): void {
  if (!enabled() || loaded) return;
  loaded = true;
  captureClickId();

  try {
    if (!window.rdt) {
      const queued = function (this: unknown, ...args: unknown[]) {
        const rdt = window.rdt;
        if (!rdt) return;
        if (rdt.sendEvent) (rdt.sendEvent as (...a: unknown[]) => void).apply(rdt, args);
        else rdt.callQueue?.push(args);
      } as Window['rdt'];
      if (queued) queued.callQueue = [];
      window.rdt = queued;

      const script = document.createElement('script');
      script.src = 'https://www.redditstatic.com/ads/pixel.js';
      script.async = true;
      document.head.appendChild(script);
    }

    window.rdt?.('init', pixelId);
    window.rdt?.('track', 'PageVisit');
  } catch (error) {
    // Tracking must never break a page — the same rule analytics.ts follows.
    console.warn('[reddit-pixel] could not initialise:', error);
  }
}

/**
 * Reports a conversion. `conversionId` has to be the value the server sends
 * for this same event; without it Reddit falls back to session-based
 * deduplication, which is markedly less accurate.
 */
export function trackRedditEvent(event: RedditEvent, options: RedditEventOptions = {}): void {
  if (!enabled()) return;
  if (!loaded) initRedditPixel();

  try {
    const payload: Record<string, unknown> = {};
    if (options.conversionId) payload.conversionId = options.conversionId;
    if (options.currency) payload.currency = options.currency;
    if (options.value !== undefined) payload.value = options.value;
    if (options.itemCount !== undefined) payload.itemCount = options.itemCount;
    window.rdt?.('track', event, payload);
  } catch (error) {
    console.warn(`[reddit-pixel] could not report ${event}:`, error);
  }
}
