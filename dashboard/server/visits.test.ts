/** Integration tests use connection-local temporary tables and roll back every write. */
import assert from 'node:assert/strict';
import { getPool } from './db/index.js';
import {
  endPageView,
  clientIp,
  liveVisitors,
  parseMarket,
  pulsePageView,
  recentVisits,
  recordPageView,
  recordPageProgress,
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
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.10' }, headers: { 'x-forwarded-for': '198.51.100.1' } }), '203.0.113.10', 'public clients cannot spoof an IP header');
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.20' } }), '203.0.113.20', 'only the trusted proxy final forwarded address is used');
  assert.equal(clientIp({ socket: { remoteAddress: 'invalid' } }), null);
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
    ALTER TABLE page_views ADD COLUMN IF NOT EXISTS client_view_id text;
    CREATE UNIQUE INDEX visitor_fixture_view_ids ON page_views(visitor_id, client_view_id) WHERE client_view_id IS NOT NULL;
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
  assert.equal(parseMarket(null), 'home');
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
  // Retrying a request that inserted successfully but lost its response must
  // return the same row without resetting duration, presence or attribution.
  const firstRetry = await recordPageView(request, view('visitor-retry', 'session-retry', { viewId: 'page-event-0001' }), '2');
  await pulsePageView({ id: firstRetry, visitorId: 'visitor-retry', durationMs: 15000, sequence: 2, visible: false }, '2');
  const sameRetry = await recordPageView(request, view('visitor-retry', 'session-retry', { viewId: 'page-event-0001' }), '2');
  assert.equal(sameRetry, firstRetry);
  const retryRows = await connection.query("SELECT duration_ms,visible FROM page_views WHERE visitor_id='visitor-retry'");
  assert.equal(retryRows.rowCount, 1);
  assert.equal(retryRows.rows[0].duration_ms, 15000);
  assert.equal(retryRows.rows[0].visible, false);
  assert.equal(await recordPageView(request, view('visitor-invalid', undefined, { viewId: 'bad!' }), '2'), null);
  // The page returned to can differ from the page most recently opened.
  const olderPage = await recordPageView(request, view('visitor-page', 'session-page', { page: 'run' }), '2');
  await recordPageView(request, view('visitor-page', 'session-page', { page: 'pricing' }), '2');
  await connection.query("UPDATE page_views SET started_at=now()-interval '2 hours',last_seen_at=now()-interval '1 hour' WHERE id=$1", [olderPage]);
  await connection.query("UPDATE page_views SET started_at=now()-interval '20 minutes',last_seen_at=now()-interval '10 minutes' WHERE visitor_id='visitor-page' AND id<>$1", [olderPage]);
  await pulsePageView({ id: olderPage, visitorId: 'visitor-page', durationMs: 20000, sequence: 1, visible: true }, '2');
  const pageSession = (await recentVisits({ range: 'today', market: 'all' }, 500)).find(row => row.visitorId === 'visitor-page')!;
  assert.equal(pageSession.lastPage, 'run');
  assert.equal(pageSession.timedViews, 1, 'partially recorded time is distinguishable from complete time');
  // A visible page can cross local midnight without a new page view today.
  const midnightPage = await recordPageView(request, view('visitor-midnight', 'session-midnight'), '2');
  await connection.query("UPDATE page_views SET started_at=(date_trunc('day',now() AT TIME ZONE 'Australia/Sydney') AT TIME ZONE 'Australia/Sydney')-interval '1 minute',last_seen_at=now() WHERE id=$1", [midnightPage]);
  assert.ok((await recentVisits({ range: 'today', market: 'all' }, 500)).some(row => row.visitorId === 'visitor-midnight'));
  assert.ok((await liveVisitors()).visitors.some(row => row.visitorId === 'visitor-midnight'));
  const filtered = await visitorReport({ range: 'today', market: 'all' });
  assert.equal(filtered.days.reduce((sum, day) => sum + day.views, 0), filtered.totals.views);
  // An old shared-browser session must never claim every page belongs to its last account.
  await connection.query("INSERT INTO users VALUES (3,'second@example.test')");
  await recordPageView(request, view('visitor-shared', 'session-shared'), '2');
  await recordPageView(request, view('visitor-shared', 'session-shared', { page: 'run' }), '3');
  const sharedSession = (await recentVisits({ range: 'today', market: 'all' }, 500)).find(row => row.visitorId === 'visitor-shared')!;
  assert.equal(sharedSession.accountCount, 2);
  assert.equal(sharedSession.email, null);
  await connection.query("INSERT INTO page_views (visitor_id,session_id,page) VALUES ('visitor-no-ip','session-no-ip','landing')");
  assert.ok((await visitorReport({ range: 'today', market: 'all' })).addresses.list.every(row => row.ip !== null), 'unknown addresses never appear as an actionable IP or inflate the address list');
  const excludedId = await recordPageView({ ...request, socket: { remoteAddress: '198.51.100.5' } } as IncomingMessage, view('visitor-excluded-later'), '2');
  await connection.query("INSERT INTO ignored_addresses(ip) VALUES ('198.51.100.5')");
  await pulsePageView({ id: excludedId, visitorId: 'visitor-excluded-later', durationMs: 60000, sequence: 1, visible: true }, '2');
  await endPageView({ id: excludedId, visitorId: 'visitor-excluded-later', durationMs: 60000 });
  const excludedRow = (await connection.query('SELECT duration_ms,presence_seq FROM page_views WHERE id=$1', [excludedId])).rows[0];
  assert.equal(excludedRow.duration_ms, null, 'ignoring an address stops updates from an already-open tab too');
  assert.equal(Number(excludedRow.presence_seq), 0);
  const originalHome = process.env.VISIT_HOME_COUNTRY;
  const originalRetention = process.env.VISIT_RETENTION_DAYS;
  try {
    process.env.VISIT_HOME_COUNTRY = 'CA';
    process.env.VISIT_RETENTION_DAYS = '42';
    const configured = await visitorReport({ range: '7d', market: 'home' });
    assert.equal(configured.home.code, 'CA');
    assert.equal(configured.retentionDays, 42);
    assert.equal(configured.totals.views, 0, 'home-country labels and filters use the same runtime setting');
    process.env.VISIT_RETENTION_DAYS = 'Infinity';
    assert.equal((await visitorReport({ range: '7d', market: 'all' })).retentionDays, 180);
  } finally {
    if (originalHome === undefined) delete process.env.VISIT_HOME_COUNTRY; else process.env.VISIT_HOME_COUNTRY = originalHome;
    if (originalRetention === undefined) delete process.env.VISIT_RETENTION_DAYS; else process.env.VISIT_RETENTION_DAYS = originalRetention;
  }
  // A close beacon can be the first request received; a later create/pulse
  // must reuse its row and must not revive the closed tab.
  const short=view('visitor-short','session-short',{viewId:'short-event-0001',startedAgoMs:1200,durationMs:1200,sequence:2,visible:false,attribution:{source:'reddit',medium:'paid',campaign:'test'}});
  await recordPageProgress(request,short,null,true);
  const initialAfterClose=await recordPageView(request,short,null);
  await recordPageProgress(request,{...short,sequence:1,visible:true,durationMs:500},null);
  const recoveredClose=(await connection.query("SELECT count(*)::int n,max(duration_ms)::int ms,bool_or(visible) visible,min(started_at)<now()-interval '1 second' AS original_start FROM page_views WHERE visitor_id='visitor-short'")).rows[0];
  assert.equal(recoveredClose.n,1);assert.equal(recoveredClose.ms,1200);assert.equal(recoveredClose.visible,false);assert.equal(recoveredClose.original_start,true);
  assert.ok(initialAfterClose);
  await recordPageProgress(request,{id:initialAfterClose,visitorId:'visitor-short',durationMs:1500},null,true);
  const legacyClose=(await connection.query('SELECT duration_ms,visible,presence_seq FROM page_views WHERE id=$1',[initialAfterClose])).rows[0];
  assert.equal(legacyClose.duration_ms,1500,'already-open older clients can still report exit timing without a sequence number');
  assert.equal(legacyClose.visible,false);assert.equal(Number(legacyClose.presence_seq),2);
  await recordPageProgress(request,{...short,visitorId:'visitor-malformed',viewId:'bad!',sequence:1},null,true);
  assert.equal((await connection.query("SELECT count(*)::int n FROM page_views WHERE visitor_id='visitor-malformed'")).rows[0].n,0);
  const ignoredProgressRequest={...request,socket:{remoteAddress:'198.51.100.5'}} as IncomingMessage;
  await recordPageProgress(ignoredProgressRequest,{...short,visitorId:'visitor-ignore-close',viewId:'ignored-event-0001'},null,true);
  assert.equal((await connection.query("SELECT count(*)::int n FROM page_views WHERE visitor_id='visitor-ignore-close'")).rows[0].n,0);

  // Isolate visit-source cases from the earlier count fixtures.
  await connection.query('DELETE FROM page_views');
  await recordPageView(request,view('visitor-campaign','campaign-session',{attribution:{source:'reddit',medium:'paid',campaign:'launch'}}),null);
  await recordPageView(request,view('visitor-campaign','campaign-session',{page:'pricing',attribution:{source:'reddit',medium:'paid',campaign:'launch'}}),null);
  await recordPageView(request,view('visitor-campaign','campaign-session',{page:'run',attribution:{source:'google'}}),'2');
  await recordPageView(request,view('visitor-campaign','second-campaign-session',{attribution:{source:'reddit'}}),'2');
  await recordPageView(request,view('visitor-google','google-session',{referrer:'https://www.google.com/search?q=private'}),null);
  await recordPageView(request,view('visitor-google','google-session',{page:'pricing',attribution:{source:'google'}}),null);
  await recordPageView(request,view('visitor-direct','direct-session'),null);
  await recordPageView(request,view('visitor-payment','payment-session',{referrer:'https://checkout.stripe.com/c/pay/private'}),null);
  const sourceReport=await visitorReport({range:'7d',market:'all'});
  assert.equal(sourceReport.totals.visits,5);
  assert.equal(sourceReport.referrers.reduce((n,r)=>n+r.views,0),5,'a visit appears in exactly one source group');
  assert.equal(sourceReport.referrers.find(r=>r.label==='reddit')?.views,2,'repeat visits count separately while page reloads do not');
  assert.equal(sourceReport.referrers.find(r=>r.label==='reddit')?.visitors,1);
  assert.equal(sourceReport.referrers.find(r=>r.label==='google')?.views,1,'campaign and referrer spellings share one canonical source');
  assert.deepEqual(sourceReport.sourceCoverage,{knownVisits:3,unknownVisits:2});
  await recordPageView(request,view('visitor-regional-auth','regional-auth-session',{referrer:'https://accounts.google.com.au/auth'}),null);
  const regional=await visitorReport({range:'7d',market:'all'});
  assert.equal(regional.referrers.find(r=>r.label==='Direct / unavailable')?.views,3,'regional sign-in returns do not invent an acquisition source');
  await recordPageView(request,view('visitor-first-source','first-source-session',{referrer:'https://www.bing.com/search?q=private'}),null);
  await recordPageView(request,view('visitor-first-source','first-source-session',{page:'pricing',attribution:{source:'reddit'}}),null);
  const firstSource=await visitorReport({range:'7d',market:'all'});
  assert.equal(firstSource.referrers.find(r=>r.label==='bing')?.views,1,'the entry referrer wins over a later campaign within the same visit');
  assert.equal(firstSource.referrers.find(r=>r.label==='reddit')?.views,2,'the later campaign is not counted as a second visit');
  const entryVisit=(await recentVisits({range:'7d',market:'all'},500)).find(r=>r.visitorId==='visitor-first-source')!;
  assert.equal(entryVisit.attributionSource,null,'visit details use the same entry source as the source totals');
  assert.equal(entryVisit.referrer,'https://www.bing.com/search');
  const [landingRow]=(await connection.query("SELECT id FROM page_views WHERE visitor_id='visitor-campaign' ORDER BY id LIMIT 1")).rows;
  await connection.query("UPDATE page_views SET started_at=(date_trunc('day',now() AT TIME ZONE 'Australia/Sydney') AT TIME ZONE 'Australia/Sydney')-interval '1 minute' WHERE id=$1",[landingRow.id]);
  await connection.query("UPDATE page_views SET attribution_source=NULL WHERE visitor_id='visitor-campaign' AND id<>$1",[landingRow.id]);
  const crossed=await visitorReport({range:'today',market:'all'});
  assert.equal(crossed.referrers.find(r=>r.label==='reddit')?.views,1,'a visit with new views today retains yesterday\'s recorded entry source');
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
