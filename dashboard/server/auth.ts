import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { query, one } from './db/index.js';
import { readEnv } from './runner.js';

/**
 * Google sign-in and sessions.
 *
 * Implemented directly against Google's OAuth 2.0 endpoints rather than pulling
 * in a framework — the flow is three HTTP calls, and a smaller dependency
 * surface is worth more than the abstraction on something that handles
 * credentials.
 */

const SESSION_COOKIE = 'myasis_session';
const SESSION_DAYS = 30;
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function creds() {
  const env = readEnv();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.OAUTH_REDIRECT_URI ??
      env.OAUTH_REDIRECT_URI ??
      'http://localhost:5180/api/auth/callback/google',
  };
}

export function googleConfigured(): boolean {
  const c = creds();
  return Boolean(c.clientId && c.clientSecret);
}

// ---------------------------------------------------------------- cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  const baseUrl = process.env.APP_BASE_URL ?? readEnv().APP_BASE_URL ?? '';
  // Local HTTP keeps working; public HTTPS receives a transport-only cookie.
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(baseUrl.startsWith('https://') ? ['Secure'] : []),
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

// ---------------------------------------------------------------- state

/**
 * CSRF state, signed rather than stored.
 *
 * The value is `nonce.hmac`, so the callback can prove the state came from us
 * without keeping server-side state between the two requests.
 */
function makeState(): string {
  const nonce = randomBytes(16).toString('hex');
  return `${nonce}.${signState(nonce)}`;
}

function signState(nonce: string): string {
  const secret = creds().clientSecret || 'myasis-dev';
  return createHash('sha256').update(`${nonce}:${secret}`).digest('hex').slice(0, 32);
}

function validState(state: string | null): boolean {
  if (!state) return false;
  const [nonce, sig] = state.split('.');
  if (!nonce || !sig) return false;
  const expected = Buffer.from(signState(nonce));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ---------------------------------------------------------------- flow

export function googleAuthUrl(): { ok: boolean; url?: string; error?: string } {
  const c = creds();
  if (!c.clientId || !c.clientSecret) {
    return { ok: false, error: 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' };
  }
  const u = new URL(AUTH_BASE);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', makeState());
  u.searchParams.set('prompt', 'select_account');
  return { ok: true, url: u.toString() };
}

export async function handleGoogleCallback(
  code: string | null,
  state: string | null,
): Promise<{ ok: boolean; cookie?: string; error?: string }> {
  const c = creds();
  if (!c.clientId || !c.clientSecret) return { ok: false, error: 'Google sign-in is not configured.' };
  if (!code) return { ok: false, error: 'No authorisation code returned.' };
  if (!validState(state)) return { ok: false, error: 'Invalid state — possible CSRF, sign-in aborted.' };

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return { ok: false, error: `Token exchange failed (${tokenRes.status}): ${(await tokenRes.text()).slice(0, 200)}` };
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return { ok: false, error: 'Google did not return an access token.' };

  const infoRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return { ok: false, error: `Could not read Google profile (${infoRes.status}).` };
  const info = (await infoRes.json()) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
    email_verified?: boolean;
  };
  if (!info.email) return { ok: false, error: 'Google account has no email address.' };

  // Matching on email links a Google login to an account already migrated from
  // the local files, rather than creating a second empty one.
  const user = await one<{ id: string }>(
    `INSERT INTO users (email, name, avatar_url, google_id, last_login_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, users.name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
       google_id = COALESCE(users.google_id, EXCLUDED.google_id),
       last_login_at = now()
     RETURNING id`,
    [info.email.toLowerCase(), info.name ?? null, info.picture ?? null, info.sub],
  );
  if (!user) return { ok: false, error: 'Could not create the account.' };

  const token = randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' seconds')::interval)`,
    [token, user.id, String(maxAge)],
  );
  return { ok: true, cookie: sessionCookie(token, maxAge) };
}

export async function currentUser(cookieHeader?: string): Promise<SessionUser | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  return one<SessionUser>(
    `SELECT u.id::text AS id, u.email, u.name, u.avatar_url AS "avatarUrl"
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
}

export async function logout(cookieHeader?: string): Promise<string> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  return sessionCookie('', 0);
}

/** Removes expired rows; cheap enough to call on each auth check. */
export async function pruneSessions() {
  await query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
}
