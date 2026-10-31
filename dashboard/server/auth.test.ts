import assert from 'node:assert/strict';
import test from 'node:test';
import { getPool } from './db/index.js';
import { googleAuthUrl, handleGoogleCallback, parseCookies } from './auth.js';

test('malformed unrelated cookies do not break session or OAuth cookie parsing', () => {
  assert.equal(parseCookies('analytics=%E0%A4%A; myasis_session=session%20token').myasis_session, 'session token');
  assert.equal(parseCookies('myasis_session=%XX; myasis_oauth=nonce').myasis_oauth, 'nonce');
  assert.equal(parseCookies('myasis_session=%XX').myasis_session, undefined, 'malformed authentication cookies are ignored');
});

test('Google callbacks validate claims and bind returning accounts to their Google subject', async () => {
  const savedEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  process.env.GOOGLE_CLIENT_ID = 'fixture-client'; process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
  const pool = getPool(), originalQuery = pool.query, originalFetch = globalThis.fetch;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let profile: Record<string, unknown> = {}, knownSubject = false, emailCollision = false;
  pool.query = (async (sql: string, params: unknown[]) => {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT')) return { rows: knownSubject ? [{ id: '42', blocked_at: null, google_id: 'google-subject' }] : [] };
    if (sql.includes('INSERT INTO sessions')) return { rows: [] };
    if (sql.includes('INSERT INTO users') && emailCollision) return { rows: [] };
    return { rows: [{ id: '42', blocked_at: null, is_new: false }] };
  }) as typeof pool.query;
  globalThis.fetch = (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'fixture-access-token' } : profile), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const callback = () => {
    const auth = googleAuthUrl(); assert.equal(auth.ok, true); if (!auth.ok) throw new Error('fixture auth failed');
    return handleGoogleCallback('fixture-code', new URL(auth.url).searchParams.get('state'), `broken=%XX; ${auth.cookie.split(';')[0]}`);
  };
  try {
    for (const claims of [
      { email: 'fixture@example.com', email_verified: true },
      { sub: '', email: 'fixture@example.com', email_verified: true },
      { sub: 'google-subject', email: 'fixture@example.com' },
      { sub: 'google-subject', email: 'fixture@example.com', email_verified: false },
      { sub: 'google-subject', email: 'fixture@example.com', email_verified: 'true' },
      { sub: 'google-subject', email: 123, email_verified: true },
    ]) {
      statements.length = 0; profile = claims;
      assert.equal((await callback()).ok, false, JSON.stringify(claims));
      assert.equal(statements.length, 0, 'invalid identity claims never read or modify accounts');
    }
    profile = { sub: 'google-subject', email: 'New@Example.com', email_verified: true, name: 'Fixture' };
    knownSubject = true; statements.length = 0;
    const returning = await callback();
    assert.equal(returning.ok, true); assert.equal(returning.userId, '42');
    assert.ok(statements.some(statement => statement.sql.startsWith('SELECT') && statement.params.includes('google-subject')));
    assert.ok(statements.some(statement => statement.sql.startsWith('UPDATE users') && statement.params.includes('new@example.com')));
    assert.ok(!statements.some(statement => statement.sql.includes('INSERT INTO users')), 'a changed email updates the existing subject instead of creating another account');
    profile = { ...profile, name: { invalid: true }, picture: ['https://example.test/avatar'] }; statements.length = 0;
    assert.equal((await callback()).ok, true, 'malformed optional claims do not invalidate a verified identity');
    assert.deepEqual(statements.find(statement => statement.sql.startsWith('UPDATE users'))!.params.slice(1, 3), [null, null], 'malformed optional claims are never stored as profile values');
    knownSubject = false; emailCollision = true; statements.length = 0;
    assert.equal((await callback()).ok, false, 'a different subject cannot take an existing email-linked account');
    assert.ok(!statements.some(statement => statement.sql.includes('INSERT INTO sessions')));
    const claim = statements.find(statement => statement.sql.includes('INSERT INTO users'))!;
    assert.match(claim.sql, /WHERE users\.google_id IS NULL OR users\.google_id = EXCLUDED\.google_id/);

    globalThis.fetch = (async () => { throw new Error('provider failure contains fixture-secret'); }) as typeof fetch;
    const failed = await callback(); assert.equal(failed.ok, false); assert.ok(!failed.error?.includes('fixture-secret'));
    globalThis.fetch = (async () => new Response('private-provider-error', { status: 503 })) as typeof fetch;
    const rejected = await callback(); assert.equal(rejected.ok, false); assert.ok(!rejected.error?.includes('private-provider-error'));
  } finally {
    pool.query = originalQuery; globalThis.fetch = originalFetch;
    if (savedEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = savedEnv.id;
    if (savedEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = savedEnv.secret;
    await pool.end();
  }
});

test('Google token and userinfo fetches share one overall deadline and stalled providers abort safely', async () => {
  const savedEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  process.env.GOOGLE_CLIENT_ID = 'fixture-client'; process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const issuedSignals: AbortSignal[] = [];
  AbortSignal.timeout = (milliseconds: number) => {
    assert.equal(milliseconds, 20_000);
    const signal = originalTimeout(20); issuedSignals.push(signal); return signal;
  };
  try {
    for (const stalledAt of ['token', 'userinfo']) {
      issuedSignals.length = 0;
      const requestedSignals: Array<AbortSignal | null | undefined> = [];
      globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
        const signal = options?.signal; requestedSignals.push(signal);
        if (stalledAt === 'userinfo' && String(url).includes('/token')) return new Response('{"access_token":"fixture-access-token"}');
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }) as typeof fetch;
      const auth = googleAuthUrl(); assert.equal(auth.ok, true); if (!auth.ok) throw new Error('fixture auth failed');
      let watchdog!: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([
          handleGoogleCallback('fixture-code', new URL(auth.url).searchParams.get('state'), auth.cookie.split(';')[0]),
          new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`${stalledAt} callback did not time out`)), 500); }),
        ]);
        assert.equal(result.ok, false); assert.equal(result.error, 'Could not complete Google sign-in. Please try again.');
        assert.equal(issuedSignals.length, 1, 'one overall deadline is created per callback');
        assert.equal(requestedSignals.length, stalledAt === 'token' ? 1 : 2);
        assert.ok(requestedSignals.every(signal => signal === issuedSignals[0]), 'both provider requests share the same deadline');
        assert.equal(issuedSignals[0].aborted, true);
      } finally { clearTimeout(watchdog); }
    }
  } finally {
    globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout;
    if (savedEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = savedEnv.id;
    if (savedEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = savedEnv.secret;
  }
});
