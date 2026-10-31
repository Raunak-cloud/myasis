import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { getPool } from './db/index.js';
import { beginGmailConnection, finishGmailConnection, encryptGmailToken, decryptGmailToken, gmailConnection, disconnectGmail, gmailRequest } from './gmail-connection.js';
import { OAuth2Client, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../../seek-bot/src/gmail-mcp-client.js';
const pool = getPool();
after(async () => { await pool.end(); });

test('Gmail OAuth uses per-user PKCE, one-time browser-bound state, exact profile address, encrypted grants and disconnect', async () => {
  const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_TOKEN_ENCRYPTION_KEY', 'APP_BASE_URL'] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', GMAIL_TOKEN_ENCRYPTION_KEY: 'fixture-encryption-key', APP_BASE_URL: 'https://app.fixture.invalid' });
  const originalQuery = pool.query, originalGetToken = OAuth2Client.prototype.getToken, originalRequest = OAuth2Client.prototype.request, originalRevoke = OAuth2Client.prototype.revokeToken;
  const states = new Map<string, { user: string; verifier: string }>();
  let stored: { refresh_token: string; gmail_email: string; scope: string } | undefined;
  let revoked = false, address = 'candidate@fixture.invalid';
  pool.query = (async (sql: string, params: any[] = []) => {
    if (sql.startsWith('DELETE FROM gmail_oauth_states WHERE expires_at')) return { rows: [] };
    if (sql.startsWith('INSERT INTO gmail_oauth_states')) { states.set(params[0], { user: params[1], verifier: params[2] }); return { rows: [] }; }
    if (sql.startsWith('DELETE FROM gmail_oauth_states WHERE state_hash')) {
      const state = states.get(params[0]);
      if (!state || state.user !== params[1]) return { rows: [] };
      states.delete(params[0]); return { rows: [{ verifier: state.verifier }] };
    }
    if (sql.startsWith('SELECT email FROM profiles')) return { rows: [{ email: 'candidate@fixture.invalid' }] };
    if (sql.startsWith('INSERT INTO google_connections')) { stored = { refresh_token: params[1], gmail_email: params[2], scope: params[3] }; return { rows: [] }; }
    if (sql.startsWith('SELECT gmail_email')) return { rows: stored ? [{ ...stored, current: stored.refresh_token.startsWith('v1.'), same_address: true, last_error: null }] : [] };
    if (sql.startsWith('DELETE FROM google_connections')) { const row = stored; stored = undefined; return { rows: row ? [row] : [] }; }
    if (sql.startsWith('DELETE FROM gmail_oauth_states WHERE user_id')) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  }) as typeof originalQuery;
  OAuth2Client.prototype.getToken = (async function(this: OAuth2Client, options: { codeVerifier: string }) {
    assert.equal(options.codeVerifier.length, 43);
    return { tokens: { refresh_token: 'fixture-private-refresh', access_token: 'fixture-private-access', scope: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].join(' ') } };
  }) as unknown as typeof originalGetToken;
  OAuth2Client.prototype.request = (async () => ({ data: { email: address, email_verified: true } })) as unknown as typeof originalRequest;
  OAuth2Client.prototype.revokeToken = (async (token: string) => { assert.equal(token, 'fixture-private-refresh'); revoked = true; }) as unknown as typeof originalRevoke;
  try {
    const encrypted = encryptGmailToken('owner', 'fixture-private-refresh');
    assert.equal(decryptGmailToken('owner', encrypted), 'fixture-private-refresh');
    assert.ok(!encrypted.includes('fixture-private-refresh'));
    assert.throws(() => decryptGmailToken('foreign-owner', encrypted), /Reconnect/);
    assert.throws(() => decryptGmailToken('owner', encrypted.slice(0, -4) + 'abcd'), /Reconnect/);
    const begin = await beginGmailConnection('owner');
    const url = new URL(begin.url), state = url.searchParams.get('state')!;
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.ok(url.searchParams.get('scope')!.includes(GMAIL_SEND_SCOPE));
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.fixture.invalid/api/auth/callback/google');
    assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const saved = states.get(createHash('sha256').update(state).digest('hex'))!;
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(saved.verifier).digest('base64url'));
    const callback = new URL(`https://app.fixture.invalid/api/auth/callback/google?state=${state}&code=fixture-code`);
    await assert.rejects(finishGmailConnection('owner', callback, 'owtomate_gmail=wrong'), /did not match/);
    await assert.rejects(finishGmailConnection('foreign', callback, begin.cookie), /expired/);
    await finishGmailConnection('owner', callback, begin.cookie);
    assert.ok(stored); assert.ok(stored!.refresh_token.startsWith('v1.'));
    const status = await gmailConnection('owner');
    assert.equal(status.connected, true); assert.equal(status.account, 'candidate@fixture.invalid');
    assert.ok(!JSON.stringify(status).includes('refresh')); assert.ok(!JSON.stringify(status).includes('secret'));
    await assert.rejects(finishGmailConnection('owner', callback, begin.cookie), /expired/);
    await disconnectGmail('owner'); assert.equal(revoked, true); assert.equal((await gmailConnection('owner')).connected, false);
    address = 'different@fixture.invalid';
    const wrong = await beginGmailConnection('owner');
    const wrongCallback = new URL(callback); wrongCallback.searchParams.set('state', new URL(wrong.url).searchParams.get('state')!);
    await assert.rejects(finishGmailConnection('owner', wrongCallback, wrong.cookie), /address saved/);
    assert.equal(stored, undefined);
  } finally {
    pool.query = originalQuery; OAuth2Client.prototype.getToken = originalGetToken; OAuth2Client.prototype.request = originalRequest; OAuth2Client.prototype.revokeToken = originalRevoke;
    for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  }
});

test('Gmail quota and malformed-request errors do not disconnect grants; late failures cannot poison a replacement grant', async () => {
  const before = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'fixture-request-key';
  const originalQuery = pool.query, originalRequest = OAuth2Client.prototype.request;
  const owner = 'gmail-request-fixture';
  let encrypted = encryptGmailToken(owner, 'first-fixture-token'), lastError: string | null = null;
  const updates: unknown[][] = [];
  let failure: unknown;
  let replaceDuringRequest = false;
  pool.query = (async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT g.refresh_token')) return { rows: [{ refresh_token: encrypted, scope: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].join(' ') }] };
    if (sql.startsWith('UPDATE google_connections')) {
      assert.match(sql, /AND refresh_token=\$3/);
      updates.push(params);
      if (params[2] === encrypted) lastError = String(params[1]);
      return { rows: [] };
    }
    throw new Error('Unexpected isolated Gmail request SQL');
  }) as typeof originalQuery;
  OAuth2Client.prototype.request = (async () => {
    if (replaceDuringRequest) { encrypted = encryptGmailToken(owner, 'replacement-fixture-token'); lastError = null; }
    if (failure) throw failure;
    return { data: { ok: true } };
  }) as unknown as typeof originalRequest;
  try {
    for (const reason of ['dailyLimitExceeded', 'userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded']) {
      failure = { response: { status: 403, data: { error: { errors: [{ reason }] } } } };
      await assert.rejects(gmailRequest(owner, 'threads'), error => (error as { code: string }).code === 'unavailable');
    }
    failure = { response: { status: 400, data: { error: { errors: [{ reason: 'badRequest' }] } } } };
    await assert.rejects(gmailRequest(owner, 'threads'), error => (error as { code: string }).code === 'unavailable');
    assert.equal(updates.length, 0); assert.equal(lastError, null);
    for (const response of [{ status: 401 }, { status: 400, data: { error: 'invalid_grant' } }, { status: 403, data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } }]) {
      failure = { response };
      await assert.rejects(gmailRequest(owner, 'threads'), error => (error as { code: string }).code === 'reconnect');
    }
    assert.equal(updates.length, 3); assert.ok(lastError);
    replaceDuringRequest = true; failure = { response: { status: 401 } };
    await assert.rejects(gmailRequest(owner, 'threads'));
    assert.equal(lastError, null, 'an old request cannot mark the newly connected token disconnected');
    replaceDuringRequest = false; failure = undefined;
    assert.deepEqual(await gmailRequest(owner, 'threads'), { ok: true });
  } finally {
    pool.query = originalQuery; OAuth2Client.prototype.request = originalRequest;
    if (before === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY; else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = before;
  }
});
