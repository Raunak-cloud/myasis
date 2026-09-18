import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { readEnv } from './runner.js';
import { clientIp } from './visits.js';

/**
 * The checks every request meets before a route sees it.
 *
 * Bodies are capped so a stream of bytes cannot fill the memory that runs
 * live in; routes that cost money or hit a third party are rate limited;
 * requests a browser marks as coming from another site are refused on
 * anything that changes state; and the only origins allowed to read the API
 * cross-origin are the ones that have a reason to.
 */

export class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`The request is larger than ${Math.round(limit / 1024)} KB.`);
  }
}

/** Plenty for a form, a profile or a cover letter; a résumé upload passes its own limit. */
export const DEFAULT_BODY_LIMIT = 256 * 1024;
/** Uploads arrive base64-encoded, so an 8 MB file needs a little under 11 MB of body. */
export const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;

/**
 * Reads a body up to `limit` bytes and no further. The connection is
 * destroyed the moment the cap is passed, so the sender cannot keep the
 * bytes flowing while the server waits for the end.
 */
export function readRawBodyLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      req.destroy();
      reject(new BodyTooLarge(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyTooLarge(limit));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A JSON body, or `{}` when it is not JSON. Multi-byte characters survive chunk boundaries. */
export async function readJsonBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<any> {
  const raw = (await readRawBodyLimited(req, limit)).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- rate limits

const buckets = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 5 * 60_000).unref();

/** True when `key` has already been seen `limit` times in the current window. */
export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

export function requesterAddress(req: IncomingMessage): string {
  return clientIp(req as never) ?? 'unknown';
}

// ---------------------------------------------------------------- origins

function appOrigin(): string | null {
  const base = process.env.APP_BASE_URL ?? readEnv().APP_BASE_URL ?? '';
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * The origin to echo in Access-Control-Allow-Origin, or null for none.
 *
 * The site's own pages are same-origin and need no CORS at all. The
 * browser extension (a chrome-extension:// origin) and a developer's
 * localhost are the only other callers with a reason to be allowed.
 */
export function allowedOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return origin === appOrigin() ? origin : null;
}

/**
 * True when the browser says this request was started by another site.
 *
 * The session cookie is SameSite=Lax, which already keeps it off cross-site
 * POSTs; this covers the cases Lax does not, such as a top-level GET that
 * carries a side effect. A request with no Sec-Fetch-Site header comes from
 * something that is not a browser (Stripe, curl) and is left to the route's
 * own authentication.
 */
export function crossSite(req: IncomingMessage): boolean {
  return req.headers['sec-fetch-site'] === 'cross-site';
}

/** A WebSocket upgrade is accepted only from the site's own pages. */
export function upgradeOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const app = appOrigin();
  if (app) return origin === app;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// ---------------------------------------------------------------- the page shell

/** True when the request carries a session cookie, whatever its validity. */
export function hasSessionCookie(req: IncomingMessage): boolean {
  return /(?:^|;\s*)myasis_session=/.test(req.headers.cookie ?? '');
}

let shellCache: { mtimeMs: number; html: string } | null = null;

/**
 * The built page without the prerendered landing inside it.
 *
 * The landing is baked into dist/index.html at build time so crawlers and
 * link previews get real content. A signed-in visitor is about to see the
 * app instead, and would otherwise watch the landing flash past first, so
 * the server strips the block for anyone who arrives with a session cookie.
 * Null when there is no built page, which is the case on a dev server.
 */
export function signedInShell(distDir: string): string | null {
  const file = `${distDir}/index.html`;
  if (!existsSync(file)) return null;
  const { mtimeMs } = statSync(file);
  if (!shellCache || shellCache.mtimeMs !== mtimeMs) {
    const html = readFileSync(file, 'utf8').replace(/<!--prerender-->[\s\S]*?<!--\/prerender-->/, '');
    shellCache = { mtimeMs, html };
  }
  return shellCache.html;
}
