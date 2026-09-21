/**
 * Reddit Conversions API — the server half of conversion tracking.
 *
 * The browser pixel in `src/redditPixel.ts` reports the same conversions from
 * the page. Ad blockers, Safari's tracking prevention and a closed tab all
 * stop the pixel; a server call stops for none of them. Reddit is told to keep
 * only one of each pair through `conversion_id`: both halves send the same id
 * for the same real-world event, and the duplicate is dropped on their side.
 * The id therefore has to be something both halves can derive without talking
 * to each other — the user's id for a sign-up, the purchase row's id for a
 * payment — never a random number generated twice.
 *
 * Nothing here is allowed to break a request it is attached to. A sign-up must
 * not fail because an ad network is down, so every call is fire-and-forget and
 * every error is swallowed after a line in the log. Off by default: with no
 * pixel id and token configured, every function here returns without sending.
 *
 * Reddit accepts events up to seven days old, but deduplicates only within two
 * days, so a retry queue would do more harm than good — a late event arrives
 * undeduplicated and is counted twice. Events go once, now, or not at all.
 */

import { createHash } from 'node:crypto';
import { readEnv } from './runner.js';
import { parseCookies } from './auth.js';
import { clientIp, type AddressableRequest } from './visits.js';

const ENDPOINT = 'https://ads-api.reddit.com/api/v2.0/conversions/events';

/** Reddit's standard events. `Custom` needs `customEventName` alongside it. */
export type RedditTrackingType =
  | 'PageVisit'
  | 'ViewContent'
  | 'Search'
  | 'AddToCart'
  | 'AddToWishlist'
  | 'Lead'
  | 'SignUp'
  | 'Purchase'
  | 'Custom';

/**
 * What the browser knew and the server does not. Collected by the pixel and
 * carried to us, because these are what Reddit matches an event back to an ad
 * click with — without them a conversion is recorded but attributed to nobody.
 */
export interface RedditMatchKeys {
  /** `_rdt_uuid` cookie. Reddit's own first-party id, their preferred match key. */
  uuid?: string | null;
  /** `rdt_cid` query parameter, set on the landing URL by the ad click. */
  clickId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
}

export interface RedditConversion {
  trackingType: RedditTrackingType;
  /** Required when `trackingType` is `Custom`; ignored otherwise. */
  customEventName?: string;
  /**
   * The same value the pixel sends for this event. Must be stable and derived,
   * not random — see the note at the top of this file.
   */
  conversionId: string;
  /** Our own user id, given to Reddit hashed. */
  externalId?: string | null;
  email?: string | null;
  /** Minor units are not used here: Reddit wants a decimal amount. */
  valueDecimal?: number;
  /** ISO 4217, and it must match the ad account's currency or the event is rejected. */
  currency?: string;
  itemCount?: number;
  match?: RedditMatchKeys;
  /** Defaults to now. Reddit refuses anything older than seven days. */
  eventAt?: Date;
}

function config(): { pixelId: string; token: string } | null {
  // `readEnvSafe` masks secrets by design, so the token is read from the raw env.
  const env = readEnv();
  const pixelId = (process.env.REDDIT_PIXEL_ID ?? env.REDDIT_PIXEL_ID ?? '').trim();
  const token = (process.env.REDDIT_CONVERSION_TOKEN ?? env.REDDIT_CONVERSION_TOKEN ?? '').trim();
  if (!pixelId || !token) return null;
  return { pixelId, token };
}

/** Whether conversions are being sent at all. Used by the admin panel to explain silence. */
export function redditCapiConfigured(): boolean {
  return config() !== null;
}

/**
 * How the last sends went.
 *
 * Kept in memory and lost on restart, deliberately: this answers "is it
 * working right now", which is the question a silent integration raises, and
 * a table of ad-network responses is not worth a migration. A token with the
 * wrong scope is the failure to expect — every event comes back 403 and
 * nothing else in the product misbehaves, so without this the first symptom
 * is a campaign that appears to convert nobody.
 */
const health = {
  accepted: 0,
  rejected: 0,
  failed: 0,
  lastAt: null as string | null,
  lastError: null as string | null,
};

export interface RedditCapiHealth {
  configured: boolean;
  /** Present and non-empty only when a token is set. */
  pixelId: string | null;
  accepted: number;
  rejected: number;
  failed: number;
  /** When an event last went out, whatever the outcome. Resets on restart. */
  lastAt: string | null;
  /** The most recent rejection or network error, trimmed. */
  lastError: string | null;
}

export function redditCapiHealth(): RedditCapiHealth {
  const settings = config();
  return { configured: settings !== null, pixelId: settings?.pixelId ?? null, ...health };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Reddit's canonical form before hashing: lowercase, dots stripped from the
 * local part, anything after a `+` dropped. `Al.ice+Apple@Example.Com` and
 * `alice@example.com` have to reach them as the same hash or the same person
 * counts twice.
 */
export function hashEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at).split('+')[0].replace(/\./g, '');
  const domain = trimmed.slice(at + 1);
  if (!local || !domain.includes('.')) return null;
  return sha256(`${local}@${domain}`);
}

/**
 * Loopback and private addresses say nothing about who someone is, and Reddit
 * warns on them. Dropped rather than sent.
 */
function usableIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const value = ip.trim();
  if (!value || value === '::1' || value === '127.0.0.1') return null;
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value)) return null;
  return value;
}

/** Drops empty values so the payload carries only signals Reddit can use. */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

function buildEvent(conversion: RedditConversion): Record<string, unknown> {
  const match = conversion.match ?? {};
  const screen =
    match.screenWidth && match.screenHeight
      ? { width: match.screenWidth, height: match.screenHeight }
      : undefined;

  const user = compact({
    uuid: match.uuid,
    ip_address: usableIp(match.ipAddress),
    user_agent: match.userAgent,
    screen_dimensions: screen,
    email: conversion.email ? hashEmail(conversion.email) : null,
    // Hashed for the same reason the email is: Reddit never needs the plaintext.
    external_id: conversion.externalId ? sha256(conversion.externalId) : null,
  });

  const metadata = compact({
    conversion_id: conversion.conversionId,
    // Reddit rejects a currency with no value, and warns on a value with no currency.
    value_decimal: conversion.valueDecimal,
    currency: conversion.valueDecimal === undefined ? undefined : conversion.currency,
    item_count: conversion.itemCount,
  });

  return compact({
    event_at: (conversion.eventAt ?? new Date()).toISOString(),
    action_source: 'WEBSITE',
    event_type: compact({
      tracking_type: conversion.trackingType,
      custom_event_name: conversion.trackingType === 'Custom' ? conversion.customEventName : undefined,
    }),
    click_id: match.clickId,
    user: Object.keys(user).length ? user : undefined,
    event_metadata: metadata,
  });
}

/**
 * Reports one conversion. Resolves either way: the caller is a sign-up or a
 * payment and must not learn that an ad network had a bad day.
 */
export async function sendRedditConversion(conversion: RedditConversion): Promise<void> {
  const settings = config();
  if (!settings) return;
  if (!conversion.conversionId) {
    console.warn('[reddit-capi] refusing an event with no conversion id; it would not deduplicate');
    return;
  }

  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(settings.pixelId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ events: [buildEvent(conversion)] }),
      signal: AbortSignal.timeout(5000),
    });
    health.lastAt = new Date().toISOString();
    if (response.ok) {
      health.accepted += 1;
      return;
    }
    health.rejected += 1;
    const detail = (await response.text()).slice(0, 300);
    health.lastError = `${response.status}: ${detail}`;
    console.warn(`[reddit-capi] ${conversion.trackingType} rejected (${response.status}): ${detail}`);
  } catch (error) {
    health.lastAt = new Date().toISOString();
    health.failed += 1;
    health.lastError = (error as Error).message.slice(0, 300);
    console.warn(`[reddit-capi] ${conversion.trackingType} failed to send:`, error);
  }
}

/**
 * Starts the send and returns immediately. The conversion is a side effect of
 * the request that triggered it, never something it waits on.
 */
export function reportRedditConversion(conversion: RedditConversion): void {
  void sendRedditConversion(conversion);
}

/**
 * The match keys the browser left on our own domain.
 *
 * `_rdt_uuid` is written by Reddit's script and `owtomate_rdt_cid` by
 * `src/redditPixel.ts`. Both are first-party cookies, so they come back on
 * every request — including the two that matter most and run none of our
 * JavaScript: the Google OAuth callback and the return from Stripe.
 */
export function matchKeysFromRequest(req: AddressableRequest): RedditMatchKeys {
  const header = req.headers?.cookie;
  const cookies = parseCookies(Array.isArray(header) ? header.join('; ') : header);
  const userAgent = req.headers?.['user-agent'];
  return {
    uuid: cookies._rdt_uuid ?? null,
    clickId: cookies.owtomate_rdt_cid ?? null,
    ipAddress: clientIp(req),
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent ?? null,
  };
}
