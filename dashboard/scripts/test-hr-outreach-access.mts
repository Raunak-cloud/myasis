/** Actual application API middleware and guards, with fictional database rows only. */
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { Plugin, UserConfig } from 'vite';
import { getPool } from '../server/db/index.js';

const pool = getPool();
const originalQuery = pool.query;
const preferences = new Map([['1', false], ['2', true]]);
let hrReads = 0, hrWrites = 0;
const mutations: Array<{ userId: string; enabled: boolean }> = [];
pool.query = (async (sql: string, values: unknown[] = []) => {
  if (sql.includes('FROM sessions')) {
    const id = values[0] === 'first-session' ? '1' : values[0] === 'second-session' ? '2' : null;
    return { rows: id ? [{ id, email: `ordinary-${id}@example.test`, name: `Fixture ${id}`, avatarUrl: null }] : [] };
  }
  if (sql.includes('FROM hr_outreach h')) {
    assert.match(sql, /WHERE h\.user_id=\$1/, 'History query must scope rows to the authenticated owner');
    assert.match(sql, /h\.id<\$2/); assert.match(sql, /h\.job_id=\$3 AND h\.platform=\$4/);
    hrReads++;
    const userId = String(values[0]);
    let rows = Array.from({ length: userId === '1' ? 55 : 1 }, (_, i) => ({ id: String(100 - i), jobId: i ? `archived-${userId}-${i}` : `job-${userId}`, platform: i === 54 ? 'external' : 'seek', title: `Role ${userId}`, company: 'Fixture Company', status: 'sent', toEmail: `hiring-${userId}@example.test`, subject: `Private subject ${userId}`, body: `Private body ${userId}` }));
    if (values[1]) rows = rows.filter(row => BigInt(row.id) < BigInt(String(values[1])));
    if (values[2]) rows = rows.filter(row => row.jobId === values[2] && row.platform === values[3]);
    return { rows: rows.slice(0, 51) };
  }
  if (sql.startsWith('SELECT enabled FROM hr_outreach_preferences')) {
    assert.match(sql, /WHERE user_id=\$1/); hrReads++;
    return { rows: [{ enabled: preferences.get(String(values[0])) }] };
  }
  if (sql.startsWith('INSERT INTO hr_outreach_preferences')) {
    const userId = String(values[0]);
    assert.ok(preferences.has(userId)); assert.equal(typeof values[1], 'boolean');
    preferences.set(userId, values[1] as boolean); hrWrites++; mutations.push({ userId, enabled: values[1] as boolean });
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE hr_outreach SET status=')) {
    assert.match(sql, /WHERE user_id=\$1/); assert.ok(preferences.has(String(values[0]))); hrWrites++; return { rows: [] };
  }
  throw new Error('Unexpected fixture database operation: ' + sql.slice(0, 100));
}) as typeof originalQuery;

let server: ReturnType<typeof createServer> | null = null;
try {
  // Only the development middleware hook is used. Preview hooks, migrations,
  // scheduled runs and background email workers are never started by this test.
  const config = (await import('../vite.config.js')).default as UserConfig;
  const plugin = (config.plugins as Plugin[]).find(item => item.name === 'seek-bot-data-api')!;
  assert.ok(plugin);
  let handle: RequestListener | null = null;
  const hook = plugin.configureServer;
  assert.equal(typeof hook, 'function');
  await (hook as Function)({
    middlewares: { use(fn: Function) { if (!handle) handle = ((req, res) => fn(req, res, () => { res.statusCode = 404; res.end(); })) as RequestListener; } },
    httpServer: null, transformIndexHtml: async (_url: string, html: string) => html,
  });
  assert.ok(handle);
  server = createServer(handle!);
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, session?: string, body?: unknown, crossSite = false, method?: string) => {
    const result = await fetch(origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(session ? { cookie: `myasis_session=${session}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(crossSite ? { 'sec-fetch-site': 'cross-site', origin: 'https://unrelated.example.test' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, body: await result.json() };
  };
  for (const path of ['/api/hr-outreach', '/api/hr-outreach/settings']) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, 'invalid-session')).status, 401);
  }
  assert.equal((await request('/api/hr-outreach/settings', undefined, { enabled: true })).status, 401);
  assert.equal(hrReads, 0); assert.equal(hrWrites, 0, 'Signed-out requests must not access private HR data');
  const first = await request('/api/hr-outreach?userId=2', 'first-session');
  assert.equal(first.status, 200); assert.equal(first.body.items[0].body, 'Private body 1');
  assert.doesNotMatch(JSON.stringify(first.body), /Private body 2|hiring-2/);
  assert.equal(first.body.items.length, 50); assert.equal(first.body.nextCursor, '51');
  const older = await request('/api/hr-outreach?cursor=51&userId=2', 'first-session');
  assert.equal(older.status, 200); assert.equal(older.body.items.length, 5); assert.equal(older.body.nextCursor, null);
  assert.equal(new Set([...first.body.items, ...older.body.items].map(item => item.id)).size, 55, 'History pages include every owner record without duplicates');
  assert.doesNotMatch(JSON.stringify(older.body), /Private body 2|hiring-2/);
  const historical = await request('/api/hr-outreach?jobId=archived-1-54&platform=external', 'first-session');
  assert.equal(historical.status, 200); assert.equal(historical.body.items.length, 1); assert.equal(historical.body.items[0].id, '46');
  assert.equal((await request('/api/hr-outreach?jobId=archived-2-54&platform=external', 'first-session')).body.items.length, 0);
  const readsBeforeInvalid = hrReads;
  for (const query of ['cursor=garbage', 'cursor=-1', 'cursor=9999999999999999999', 'jobId=one', 'platform=seek', 'jobId=one&platform=INVALID']) assert.equal((await request('/api/hr-outreach?' + query, 'first-session')).status, 400);
  assert.equal(hrReads, readsBeforeInvalid, 'Invalid pagination filters never reach the database');
  const second = await request('/api/hr-outreach', 'second-session');
  assert.equal(second.status, 200); assert.equal(second.body.items[0].body, 'Private body 2');
  assert.deepEqual((await request('/api/hr-outreach/settings', 'first-session')).body, { enabled: false });
  assert.deepEqual((await request('/api/hr-outreach/settings', 'second-session')).body, { enabled: true });
  const writesBeforeBad = hrWrites;
  assert.equal((await request('/api/hr-outreach/settings', 'first-session', { enabled: true }, true)).status, 403);
  for (const enabled of [undefined, null, 'true', 1, [], {}]) assert.equal((await request('/api/hr-outreach/settings', 'first-session', { enabled })).status, 400);
  assert.equal(hrWrites, writesBeforeBad, 'Rejected writes leave both accounts unchanged');
  const save = await request('/api/hr-outreach/settings?userId=2', 'first-session', { enabled: true, userId: '2' });
  assert.equal(save.status, 200); assert.deepEqual(save.body, { enabled: true });
  assert.deepEqual(mutations, [{ userId: '1', enabled: true }], 'Query/body owner spoofing cannot write another account');
  await request('/api/hr-outreach/settings', 'second-session', { enabled: false });
  assert.equal(preferences.get('1'), true); assert.equal(preferences.get('2'), false);
  assert.equal((await request('/api/hr-outreach', 'first-session', undefined, false, 'DELETE')).status, 405);
  assert.equal((await request('/api/hr-outreach/settings', 'first-session', undefined, false, 'DELETE')).status, 405);
  console.log('PASS: real HR API middleware rejects signed-out, cross-site and invalid writes/filters; owner-scoped pagination and historical job lookup; ordinary users cannot spoof another owner; fixture database only, no workers or email sends.');
} finally {
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  pool.query = originalQuery;
  await pool.end();
}
