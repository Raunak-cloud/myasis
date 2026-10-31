/** Integration tests use connection-local temporary tables and roll back every write. */
import assert from 'node:assert/strict';
import { getPool } from './db/index.js';
import {
  endPageView,
  liveVisitors,
  parseMarket,
  pulsePageView,
  recentVisits,
  recordPageView,
  visitorReport,
} from './visits.js';
import type { IncomingMessage } from 'node:http';

const pool = getPool();
const connection = await pool.connect();
const originalQuery = pool.query;
const originalAdmins = process.env.ADMIN_EMAILS;
const originalGeoip = process.env.GEOIP_DB;
process.env.GEOIP_DB = ''; // No persistent file watcher or external location fixture.
process.env.ADMIN_EMAILS = 'visitor-admin@example.test';
let pending = Promise.resolve();
pool.query = ((...args: unknown[]) => {
  const result = pending.then(() => (connection.query as Function)(...args));
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}) as typeof originalQuery;
try {
  await connection.query('BEGIN');
  await connection.query(`CREATE TEMP TABLE users (id bigint PRIMARY KEY, email text);
    INSERT INTO users VALUES (1, 'visitor-admin@example.test'), (2, 'visitor@example.test');
    CREATE TEMP TABLE ignored_addresses (ip inet PRIMARY KEY, note text, created_at timestamptz DEFAULT now());
    INSERT INTO ignored_addresses (ip) VALUES ('127.0.0.1');
    CREATE TEMP TABLE page_views (LIKE public.page_views INCLUDING DEFAULTS);
    CREATE TEMP SEQUENCE visitor_fixture_ids;
    ALTER TABLE page_views ALTER COLUMN id SET DEFAULT nextval('pg_temp.visitor_fixture_ids');
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS visible boolean NOT NULL DEFAULT false;
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS presence_seq bigint NOT NULL DEFAULT 0;
    SET LOCAL search_path = pg_temp, public;`);
  const request = {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0) Chrome/145.0.0.0 Safari/537.36',
      host: 'example.test',
    },
    socket: { remoteAddress: '203.0.113.10' },
  } as unknown as IncomingMessage;
  const view = (
    visitorId: string,
    sessionId = 'session-test',
    extra: object = {},
  ) => ({ visitorId, sessionId, page: 'landing', visible: true, ...extra });
  const id = await recordPageView(
    request,
    view('visitor-main', undefined, {
      referrer: 'https://external.test/page?token=secret#hash',
    }),
    '2',
  );
  assert.ok(id);
  let stored = (
    await connection.query('SELECT * FROM page_views WHERE id=$1', [id])
  ).rows[0];
  assert.equal(stored.referrer, 'https://external.test/page');
  assert.equal(stored.duration_ms, null, 'unknown duration stays unknown');
  assert.equal((await liveVisitors()).count, 1);
  const message = {
    id,
    visitorId: 'visitor-main',
    durationMs: 20000,
    sequence: 2,
    visible: true,
  };
  await pulsePageView(message, '2');
  await endPageView({ ...message, durationMs: 23000, sequence: 3 });
  await pulsePageView(message, '2');
  assert.equal(
    (await liveVisitors()).count,
    0,
    'a delayed heartbeat must not revive a hidden tab',
  );
  stored = (
    await connection.query('SELECT * FROM page_views WHERE id=$1', [id])
  ).rows[0];
  assert.equal(stored.duration_ms, 23000);
  await pulsePageView({ ...message, durationMs: 24000, sequence: 4 });
  await recordPageView(
    request,
    view('visitor-main', 'session-other', { page: 'pricing' }),
    '2',
  );
  assert.equal((await liveVisitors()).count, 1, 'two visible tabs count once');
  await connection.query(
    "UPDATE page_views SET last_seen_at = now() - interval '61 seconds'",
  );
  assert.equal(
    (await liveVisitors()).count,
    0,
    'a crashed client expires without a leave beacon',
  );
  // Before-sign-in and signed-out visits by known admins are excluded in all queries.
  await recordPageView(request, view('visitor-admin'), null);
  await recordPageView(request, view('visitor-admin', 'admin-session'), '1');
  await recordPageView(
    request,
    view('visitor-admin', 'signed-out-admin'),
    null,
  );
  assert.equal((await liveVisitors()).count, 0);
  // A normal account on a shared browser is still a customer.
  await recordPageView(request, view('visitor-admin', 'customer-session'), '2');
  assert.equal((await liveVisitors()).count, 1);
  const ignoredRequest = {
    ...request,
    socket: { remoteAddress: '127.0.0.1' },
  } as IncomingMessage;
  assert.equal(
    await recordPageView(ignoredRequest, view('visitor-ignored'), null),
    null,
  );
  assert.equal(await recordPageView(request, view('invalid!'), null), null);
  await recordPageView(
    request,
    view('visitor-unsafe', undefined, { referrer: 'javascript:alert(1)' }),
    null,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT referrer FROM page_views WHERE visitor_id='visitor-unsafe'",
      )
    ).rows[0].referrer,
    null,
  );
  await connection.query(`INSERT INTO page_views (visitor_id, session_id, page, ip, country_code, country)
    SELECT 'browser-' || n, 'shared-session', 'landing', ('10.0.1.' || n)::inet, 'AU', 'Australia' FROM generate_series(1, 202) n`);
  await connection.query("INSERT INTO page_views (visitor_id, session_id, page, ip) VALUES ('ignored-legacy', 'ignored-session', 'landing', '127.0.0.1')");
  await connection.query("UPDATE page_views SET referrer='null/' WHERE visitor_id='visitor-unsafe'");
  const all = await visitorReport({ range: '7d', market: 'all' });
  assert.equal((await visitorReport({ range: 'today', market: 'all' })).totals.views, all.totals.views, 'today uses the configured local midnight');
  const home = await visitorReport({ range: '7d', market: 'home' });
  const abroad = await visitorReport({ range: '7d', market: 'abroad' });
  assert.equal(
    all.totals.views,
    home.totals.views + abroad.totals.views,
    'all includes unknown countries',
  );
  assert.equal(all.totals.views, 206, 'three admin rows must be excluded');
  assert.equal(
    all.addresses.count,
    203,
    'distinct address total is not capped to its list',
  );
  assert.equal(all.addresses.list.length, 200);
  assert.equal(
    home.totals.visits,
    202,
    'different browsers with identical session IDs are separate visits',
  );
  const recent = await recentVisits({ range: '7d', market: 'all' }, 500);
  assert.equal(recent.length, all.totals.visits);
  assert.equal(
    recent.some((row) => row.email === 'visitor-admin@example.test'),
    false,
  );
  assert.equal(recent.find((row) => row.visitorId === 'visitor-unsafe')?.durationMs, null);
  assert.equal(recent.find((row) => row.visitorId === 'visitor-unsafe')?.referrer, null, 'legacy invalid referrers are not claimed as sources');
  assert.equal(
    recent.find((row) => row.sessionId === 'customer-session')?.email,
    'visitor@example.test',
  );
  assert.equal(parseMarket(null), 'all');
  // A returning visitor keeps the same browser-session ID when an old tab is
  // reopened. A heartbeat must bring that visit above a newer, inactive visit,
  // including when LIMIT would otherwise hide it from the report.
  await connection.query("UPDATE page_views SET started_at = now() - interval '3 days', last_seen_at = now() - interval '3 days'");
  const returningId = await recordPageView(request, view('visitor-returning', 'session-returning'), '2');
  const returningPageId = await recordPageView(request, view('visitor-returning', 'session-returning', { page: 'run' }), '2');
  const newerId = await recordPageView(request, view('visitor-newer', 'session-newer'), '2');
  await connection.query("UPDATE page_views SET started_at = now() - interval '2 days', last_seen_at = now() - interval '1 hour' WHERE id=$1", [returningId]);
  await connection.query("UPDATE page_views SET started_at = now() - interval '2 hours', last_seen_at = now() - interval '1 hour' WHERE id=$1", [returningPageId]);
  await connection.query("UPDATE page_views SET started_at = now() - interval '10 minutes', last_seen_at = now() - interval '10 minutes' WHERE id=$1", [newerId]);
  await pulsePageView({ id: returningPageId, visitorId: 'visitor-returning', durationMs: 12000, sequence: 1, visible: true }, '2');
  const latest = await recentVisits({ range: '7d', market: 'all' }, 1);
  assert.equal(latest[0]?.visitorId, 'visitor-returning', 'latest activity must win before limiting sessions, even when its session started earlier');
  assert.equal(latest[0]?.email, 'visitor@example.test');
  assert.equal(latest[0]?.views, 2, 'heartbeats do not invent page views or sessions');
  assert.ok(Date.parse(latest[0].endedAt) > Date.parse(latest[0].startedAt));
  console.log(
    'PASS visitor presence, expiry, admin exclusion, shared devices, counts, location scope, referrer privacy and unknown duration (temporary PostgreSQL tables only)',
  );
} finally {
  await connection.query('ROLLBACK');
  pool.query = originalQuery;
  connection.release();
  if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = originalAdmins;
  if (originalGeoip === undefined) delete process.env.GEOIP_DB;
  else process.env.GEOIP_DB = originalGeoip;
  await pool.end();
}
