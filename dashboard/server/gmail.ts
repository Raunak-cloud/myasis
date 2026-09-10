import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { query, one } from './db/index.js';
import { readEnv } from './runner.js';

/**
 * Per-account Gmail connection, read-only, used by a run to pick up the
 * one-time codes employer sites email during an application.
 *
 * Reuses the sign-in OAuth client and its registered redirect URI: the state
 * carries a `gmail.` prefix and the account id, so the shared callback route
 * can tell a Gmail connection from a sign-in and store the refresh token
 * against the right account. Nothing here reads mail — that happens inside
 * the run, with the token handed over as an env override.
 */

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly email';

function creds() {
  const env = readEnv();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.OAUTH_REDIRECT_URI ?? env.OAUTH_REDIRECT_URI ?? 'http://localhost:5180/api/auth/callback/google',
  };
}

function sign(userId: string, nonce: string): string {
  const secret = creds().clientSecret || 'myasis-dev';
  return createHash('sha256').update(`gmail:${userId}:${nonce}:${secret}`).digest('hex').slice(0, 32);
}

export function isGmailState(state: string | null): boolean {
  return Boolean(state?.startsWith('gmail.'));
}

function userFromState(state: string | null): string | null {
  if (!state) return null;
  const [prefix, userId, nonce, sig] = state.split('.');
  if (prefix !== 'gmail' || !userId || !nonce || !sig) return null;
  const expected = Buffer.from(sign(userId, nonce));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got) ? userId : null;
}

export function gmailAuthUrl(userId: string): { ok: boolean; url?: string; error?: string } {
  const c = creds();
  if (!c.clientId || !c.clientSecret) {
    return { ok: false, error: 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' };
  }
  const nonce = randomBytes(16).toString('hex');
  const u = new URL(AUTH_BASE);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', `gmail.${userId}.${nonce}.${sign(userId, nonce)}`);
  // Offline + consent is what yields a refresh token, every time, even for an account that consented before.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  return { ok: true, url: u.toString() };
}

export async function handleGmailCallback(
  code: string | null,
  state: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const c = creds();
  const userId = userFromState(state);
  if (!userId) return { ok: false, error: 'Invalid state — the Gmail connection was aborted.' };
  if (!code) return { ok: false, error: 'No authorisation code returned.' };

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
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!tokens.refresh_token) {
    return {
      ok: false,
      error: 'Google did not return a long-lived token. Remove Myasis under your Google account\'s third-party access and connect again.',
    };
  }
  if (!/gmail\.readonly/.test(tokens.scope ?? '')) {
    return { ok: false, error: 'Mailbox access was not granted. Tick the Gmail permission when connecting.' };
  }

  let email: string | null = null;
  if (tokens.access_token) {
    const infoRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (infoRes.ok) email = ((await infoRes.json()) as { email?: string }).email ?? null;
  }

  await query(
    `INSERT INTO google_connections (user_id, refresh_token, gmail_email, scope, connected_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       gmail_email = EXCLUDED.gmail_email,
       scope = EXCLUDED.scope,
       connected_at = now()`,
    [userId, tokens.refresh_token, email, tokens.scope ?? SCOPE],
  );
  return { ok: true };
}

export async function gmailStatus(userId: string): Promise<{ connected: boolean; email: string | null; connectedAt: string | null }> {
  const row = await one<{ gmail_email: string | null; connected_at: Date }>(
    `SELECT gmail_email, connected_at FROM google_connections WHERE user_id = $1`,
    [userId],
  );
  return row
    ? { connected: true, email: row.gmail_email, connectedAt: new Date(row.connected_at).toISOString() }
    : { connected: false, email: null, connectedAt: null };
}

export async function disconnectGmail(userId: string): Promise<void> {
  await query(`DELETE FROM google_connections WHERE user_id = $1`, [userId]);
}

/** The token a run needs, or null when the account has not connected Gmail. */
export async function gmailRefreshToken(userId: string): Promise<string | null> {
  const row = await one<{ refresh_token: string }>(`SELECT refresh_token FROM google_connections WHERE user_id = $1`, [userId]);
  return row?.refresh_token ?? null;
}
