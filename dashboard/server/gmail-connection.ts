import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { one, query } from './db/index.js';
import { readEnv } from './runner.js';
import { accountUnavailable } from './account-lifecycle.js';
import { OAuth2Client, CodeChallengeMethod, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../../seek-bot/src/gmail-mcp-client.js';
import { GmailServiceError } from '../../seek-bot/src/gmail-mcp-service.js';

const SCOPES = ['openid', 'email', GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const active = new Map<string, { encrypted: string; oauth: InstanceType<typeof OAuth2Client> }>();
export function gmailConfig() {
  const env = { ...readEnv(), ...process.env };
  const clientId = env.GOOGLE_CLIENT_ID ?? '', clientSecret = env.GOOGLE_CLIENT_SECRET ?? '';
  const base = (env.APP_BASE_URL || 'http://localhost:5180').replace(/\/$/, '');
  return { clientId, clientSecret, redirectUri: env.OAUTH_REDIRECT_URI || `${base}/api/auth/callback/google`,
    key: env.GMAIL_TOKEN_ENCRYPTION_KEY || env.SITE_AUTH_SECRET || clientSecret, configured: Boolean(clientId && clientSecret) };
}
export function encryptGmailToken(userId: string, token: string): string {
  const secret = gmailConfig().key;
  if (!secret) throw new GmailServiceError('reconnect', 'Google authorization is not configured.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(`gmail-mcp-v1:${secret}`).digest(), iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function decryptGmailToken(userId: string, encrypted: string): string {
  const [version, iv, tag, body, extra] = encrypted.split('.');
  if (version !== 'v1' || !iv || !tag || !body || extra) throw new GmailServiceError('reconnect', 'Reconnect Gmail in Setup.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(`gmail-mcp-v1:${gmailConfig().key}`).digest(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(userId)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new GmailServiceError('reconnect', 'Reconnect Gmail in Setup.'); }
}
const oauthCookie = (state: string, maxAge = 600) => `owtomate_gmail=${state}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${maxAge}${gmailConfig().redirectUri.startsWith('https:') ? '; Secure' : ''}`;
export const clearGmailCookie = () => oauthCookie('', 0);
export async function beginGmailConnection(userId: string) {
  const c = gmailConfig();
  if (!c.configured) throw new GmailServiceError('reconnect', 'Google authorization is not configured.');
  const state = `gmail.${randomBytes(32).toString('base64url')}`, verifier = randomBytes(32).toString('base64url');
  await query('DELETE FROM gmail_oauth_states WHERE expires_at<now()');
  await query("INSERT INTO gmail_oauth_states(state_hash,user_id,verifier,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [hash(state), userId, verifier]);
  const oauth = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri });
  const url = oauth.generateAuthUrl({ response_type: 'code', access_type: 'offline', prompt: 'consent select_account', scope: SCOPES,
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: CodeChallengeMethod.S256 });
  return { url, cookie: oauthCookie(state) };
}
export async function finishGmailConnection(userId: string, url: URL, cookie?: string): Promise<void> {
  const state = url.searchParams.get('state') || '';
  const started = (cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('owtomate_gmail='))?.slice('owtomate_gmail='.length);
  if (!/^gmail\.[\w-]{43}$/.test(state) || started !== state) throw new GmailServiceError('reconnect', 'Gmail connection expired or did not match this browser. Try again.');
  const pending = await one<{ verifier: string }>('DELETE FROM gmail_oauth_states WHERE state_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING verifier', [hash(state), userId]);
  if (!pending) throw new GmailServiceError('reconnect', 'Gmail connection expired. Try again.');
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) throw new GmailServiceError('reconnect', 'Gmail connection was not authorized.');
  const c = gmailConfig(), oauth = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri,
    transporterOptions: { timeout: 20_000 } });
  let tokens;
  try { tokens = (await oauth.getToken({ code, codeVerifier: pending.verifier, redirect_uri: c.redirectUri })).tokens; }
  catch { throw new GmailServiceError('reconnect', 'Google authorization could not complete. Try connecting Gmail again.'); }
  const scope = tokens.scope || '';
  if (!tokens.refresh_token || ![GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].every(required => scope.split(' ').includes(required))) {
    throw new GmailServiceError('reconnect', 'Grant Gmail read and send access to connect verification emails and confirmed email applications.');
  }
  oauth.setCredentials(tokens);
  let identity;
  try { identity = (await oauth.request<{ email: string; email_verified: boolean }>({ url: 'https://openidconnect.googleapis.com/v1/userinfo' })).data; }
  catch { throw new GmailServiceError('reconnect', 'Google did not confirm the connected Gmail address.'); }
  const profile = await one<{ email: string }>('SELECT email FROM profiles WHERE user_id=$1', [userId]);
  if (!identity.email_verified || !identity.email || profile?.email?.trim().toLowerCase() !== identity.email.toLowerCase()) {
    throw new GmailServiceError('reconnect', 'Connect the Gmail address saved in your application profile.');
  }
  await query(`INSERT INTO google_connections(user_id,refresh_token,gmail_email,scope,last_error) VALUES($1,$2,$3,$4,NULL)
    ON CONFLICT(user_id) DO UPDATE SET refresh_token=EXCLUDED.refresh_token,gmail_email=EXCLUDED.gmail_email,scope=EXCLUDED.scope,last_error=NULL,connected_at=now()`,
  [userId, encryptGmailToken(userId, tokens.refresh_token), identity.email.toLowerCase(), scope]);
  active.delete(userId);
}
export async function gmailConnection(userId: string) {
  const row = await one<{ gmail_email: string; scope: string; last_error: string | null; current: boolean; same_address: boolean }>(
    `SELECT gmail_email,scope,last_error,(refresh_token LIKE 'v1.%') AS current,
      (lower(gmail_email)=(SELECT lower(trim(email)) FROM profiles WHERE user_id=$1)) AS same_address
      FROM google_connections WHERE user_id=$1`, [userId]);
  const connected = Boolean(row?.current && row.same_address && !row.last_error && [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].every(scope => row.scope?.split(' ').includes(scope)));
  return { connected, configured: gmailConfig().configured, account: row?.current ? row.gmail_email : null,
    error: row?.last_error || (row && !connected ? row.same_address ? 'Reconnect Gmail to authorize MCP access.' : 'Connect the Gmail address saved in your application profile.' : null) };
}
export async function disconnectGmail(userId: string): Promise<void> {
  const row = await one<{ refresh_token: string }>('DELETE FROM google_connections WHERE user_id=$1 RETURNING refresh_token', [userId]);
  await query('DELETE FROM gmail_oauth_states WHERE user_id=$1', [userId]); active.delete(userId);
  if (row?.refresh_token.startsWith('v1.')) {
    try {
      const c = gmailConfig(), oauth = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, transporterOptions: { timeout: 10_000 } });
      await oauth.revokeToken(decryptGmailToken(userId, row.refresh_token));
    } catch { /* Removing the local grant immediately disables every MCP lease. */ }
  }
}
export async function gmailRequest<T = Record<string, any>>(userId: string, path: string, options: { method?: 'GET' | 'POST'; data?: unknown; params?: Record<string, string | number> } = {}): Promise<T> {
  if (accountUnavailable(userId)) throw new GmailServiceError('reconnect', 'This account is unavailable.');
  const row = await one<{ refresh_token: string; scope: string }>(`SELECT g.refresh_token,g.scope FROM google_connections g JOIN users u ON u.id=g.user_id
    JOIN profiles p ON p.user_id=g.user_id WHERE g.user_id=$1 AND u.blocked_at IS NULL AND lower(trim(p.email))=lower(g.gmail_email)`, [userId]);
  if (!row || ![GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].every(scope => row.scope?.split(' ').includes(scope))) throw new GmailServiceError('reconnect', 'Connect Gmail in Setup.');
  let entry = active.get(userId);
  if (!entry || entry.encrypted !== row.refresh_token) {
    const c = gmailConfig(), oauth = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret,
      transporterOptions: { timeout: 20_000, retry: false } });
    oauth.setCredentials({ refresh_token: decryptGmailToken(userId, row.refresh_token) });
    entry = { encrypted: row.refresh_token, oauth }; active.set(userId, entry);
  }
  try {
    return (await entry.oauth.request<T>({ url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, ...options, retry: false, timeout: 20_000, maxContentLength: 2_000_000 })).data;
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 400 || status === 401 || status === 403) {
      const message = status === 403 ? 'Gmail access was refused. Enable Gmail API in the Google OAuth project and reconnect Gmail.' : 'Reconnect Gmail in Setup. Google authorization expired or was revoked.';
      await query('UPDATE google_connections SET last_error=$2 WHERE user_id=$1', [userId, message]); active.delete(userId);
    }
    const failure = new GmailServiceError(status === 400 || status === 401 || status === 403 ? 'reconnect' : 'unavailable', 'Gmail request could not complete.');
    Object.assign(failure, { providerStatus: status }); throw failure;
  }
}
