import type { BrowserContext, CDPSession, Frame, Page } from 'patchright';
import { capMonsterReady, solveTask } from './capmonster.js';

/**
 * reCAPTCHA v3 through CapMonster.
 *
 * v3 never shows a wall, so there is nothing for the page judge to catch: the
 * site calls grecaptcha.execute(), Google's hidden iframe POSTs to `/reload`,
 * and the token in that response goes to the site's server with the form. The
 * swap happens on that one response — the iframe's own network session is
 * paused over CDP, CapMonster's token replaces Google's, and the page's
 * promise resolves as it always would. No script enters any page, and only
 * `/reload` requests are intercepted, so the HTTP cache and every other request
 * are untouched.
 *
 * Whatever goes wrong — no key, a slow solve, an unexpected response — the
 * browser's own token is let through, so this can only ever add a token, never
 * lose one.
 */

const ANCHOR = /^https:\/\/(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(api2|enterprise)\/anchor\?/;
/**
 * Measured: grecaptcha abandons a `/reload` held for about 10 seconds and falls
 * back on its own. A solve that is not back by then is let go rather than
 * waited for.
 */
const V3_DEADLINE_MS = 9_000;
const PREWARM_DEADLINE_MS = 100_000;
const PREWARM_MAX_AGE_MS = 90_000;

const minScore = () => Math.min(0.9, Math.max(0.1, Number(process.env.CAPMONSTER_V3_MIN_SCORE) || 0.7));
/** Hostnames to swap tokens on; empty means everywhere v3 appears. */
const sites = () => (process.env.CAPMONSTER_V3_SITES ?? '').split(',').map(site => site.trim().toLowerCase()).filter(Boolean);

/** The first string in a protobuf message's top-level `field`. `/reload` carries the action in field 8. */
function protobufString(message: Buffer, field: number): string | undefined {
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; at < message.length; shift += 7) {
      const byte = message[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  while (at < message.length) {
    const tag = varint();
    const wire = tag & 7;
    if (wire === 0) varint();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = varint();
      if (tag >>> 3 === field) return message.subarray(at, at + length).toString('utf8');
      at += length;
    } else return undefined;
  }
  return undefined;
}

interface Paused {
  requestId: string;
  request: { url: string; postDataEntries?: Array<{ bytes?: string }> };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

interface SolvedToken {
  taskId: number;
  solution: Record<string, unknown>;
}

interface WarmToken {
  startedAt: number;
  promise: Promise<SolvedToken | null>;
}

/**
 * Indeed asks for the same v3 action several times while an application moves
 * through SmartApply. CapMonster normally needs about eight seconds, while
 * Chrome only lets us hold Google's response for about nine. Start the next
 * solve as soon as the iframe appears (and immediately after consuming one),
 * so the token is ready before Indeed asks for it.
 */
const warmed = new WeakMap<Frame, Map<string, WarmToken>>();

function expectedAction(host: Frame): string | undefined {
  try {
    return new URL(host.url()).hostname === 'smartapply.indeed.com' ? 'PREVIEW_GENERATION' : undefined;
  } catch {
    return undefined;
  }
}

function warmKey(siteKey: string, action: string, enterprise: boolean): string {
  return `${enterprise ? 'enterprise' : 'standard'}:${siteKey}:${action}`;
}

function prewarm(host: Frame, siteKey: string, action: string, enterprise: boolean): WarmToken {
  let cache = warmed.get(host);
  if (!cache) {
    cache = new Map();
    warmed.set(host, cache);
  }
  const key = warmKey(siteKey, action, enterprise);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.startedAt < PREWARM_MAX_AGE_MS) return existing;

  const entry: WarmToken = {
    startedAt: Date.now(),
    promise: solveTask({
      type: 'RecaptchaV3TaskProxyless',
      websiteURL: host.url(),
      websiteKey: siteKey,
      pageAction: action,
      minScore: minScore(),
      isEnterprise: enterprise,
    }, PREWARM_DEADLINE_MS, 2).catch(error => {
      console.warn(`[captcha] capmonster: reCAPTCHA v3 prewarm failed (${(error as Error).message}).`);
      return null;
    }),
  };
  cache.set(key, entry);
  return entry;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('prewarmed token was not ready in time')), ms)),
  ]);
}

async function swapToken(session: CDPSession, host: Frame, enterprise: boolean, event: Paused): Promise<void> {
  let fulfilled = false;
  try {
    const siteKey = new URL(event.request.url).searchParams.get('k');
    const allowed = sites();
    if (event.responseStatusCode !== 200 || !siteKey || !capMonsterReady()) return;
    if (allowed.length && !allowed.some(site => new URL(host.url()).hostname.endsWith(site))) return;
    // v3 is loaded as api.js?render=<site key>; an invisible v2 widget shares this endpoint but not that script.
    const isV3 = await host.evaluate(key => [...document.scripts].some(script => script.src.includes(`render=${key}`)), siteKey);
    if (!isV3) return;

    const reply = await session.send('Fetch.getResponseBody', { requestId: event.requestId });
    const text = reply.base64Encoded ? Buffer.from(reply.body, 'base64').toString('utf8') : reply.body;
    const start = text.indexOf('[');
    const payload = start < 0 ? null : (JSON.parse(text.slice(start)) as unknown[]);
    if (!payload || payload[0] !== 'rresp' || typeof payload[1] !== 'string') return;

    const posted = Buffer.concat((event.request.postDataEntries ?? []).map(entry => Buffer.from(entry.bytes ?? '', 'base64')));
    const action = protobufString(posted, 8) || 'verify';
    const started = Date.now();
    const cache = warmed.get(host);
    const key = warmKey(siteKey, action, enterprise);
    const warm = cache?.get(key);
    const solved = warm && Date.now() - warm.startedAt < PREWARM_MAX_AGE_MS
      ? await within(warm.promise, V3_DEADLINE_MS)
      : await solveTask({
          type: 'RecaptchaV3TaskProxyless',
          websiteURL: host.url(),
          websiteKey: siteKey,
          pageAction: action,
          minScore: minScore(),
          isEnterprise: enterprise,
        }, V3_DEADLINE_MS, 1);
    const solution = solved?.solution;
    if (!solution || typeof solution.gRecaptchaResponse !== 'string' || !solution.gRecaptchaResponse) return;

    cache?.delete(key);
    if (expectedAction(host) === action) prewarm(host, siteKey, action, enterprise);

    payload[1] = solution.gRecaptchaResponse;
    await session.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      // The body read above is already decoded, so the original encoding and length no longer describe it.
      responseHeaders: (event.responseHeaders ?? []).filter(header => !/^content-(encoding|length)$/i.test(header.name)),
      body: Buffer.from(text.slice(0, start) + JSON.stringify(payload)).toString('base64'),
    });
    fulfilled = true;
    console.log(`[captcha] capmonster: reCAPTCHA v3 token supplied for "${action}" on ${new URL(host.url()).hostname} (${((Date.now() - started) / 1000).toFixed(1)}s).`);
  } catch (error) {
    console.warn(`[captcha] capmonster: reCAPTCHA v3 kept the browser's own token (${(error as Error).message}).`);
  } finally {
    if (!fulfilled) await session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  }
}

/**
 * One interception per iframe. Two sessions on the same iframe would each pause
 * the same request and each pay for a solve, so a frame that is already being
 * watched is left alone; the entry is dropped when its session dies with the
 * iframe's process, and the next navigation attaches afresh.
 */
const watched = new WeakSet<Frame>();

async function intercept(page: Page, frame: Frame): Promise<void> {
  const match = ANCHOR.exec(frame.url());
  const host = frame.parentFrame();
  if (!match || !host || watched.has(frame)) return;
  watched.add(frame);
  try {
    // Google's iframe is cross-site, so it has a network session of its own.
    const session = await page.context().newCDPSession(frame);
    session.on('close', () => watched.delete(frame));
    session.on('Fetch.requestPaused', event => void swapToken(session, host, match[1] === 'enterprise', event as Paused));
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*/recaptcha/*/reload?*', requestStage: 'Response' }] });
    const siteKey = new URL(frame.url()).searchParams.get('k');
    const action = expectedAction(host);
    if (siteKey && action && capMonsterReady()) {
      const allowed = sites();
      if (!allowed.length || allowed.some(site => new URL(host.url()).hostname.endsWith(site))) {
        const isV3 = await host.evaluate(key => [...document.scripts].some(script => script.src.includes(`render=${key}`)), siteKey);
        if (isV3) prewarm(host, siteKey, action, match[1] === 'enterprise');
      }
    }
  } catch {
    watched.delete(frame);
  }
}

/** Starts watching every tab of the context for reCAPTCHA v3 iframes. */
export function watchRecaptchaV3(context: BrowserContext): void {
  const watch = (page: Page) => {
    page.on('framenavigated', frame => void intercept(page, frame));
    for (const frame of page.frames()) void intercept(page, frame);
  };
  context.on('page', watch);
  context.pages().forEach(watch);
}
