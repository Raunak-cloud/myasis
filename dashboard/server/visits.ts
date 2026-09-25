import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { one, query } from './db/index.js';
import { isAdmin } from './billing.js';
import { RUN_TIME_ZONE } from './entitlements.js';
import { geoipConfigured, lookupPlace } from './geoip.js';

/**
 * First-party visitor analytics: who looked at what, from where, for how long.
 *
 * The page sends a beacon when it is shown and another when it is left, and
 * each becomes or completes one row in page_views. Everything an operator
 * sees in the Visitors view is a query over those rows. There is no third
 * party in the loop: the address comes off the connection, the place comes
 * from a local database (geoip.ts), and the rows are pruned on a schedule.
 */

/** Days of page views kept. An address with a place is personal information; the counts do not need it forever. */
const RETENTION_DAYS = Math.max(7, Number(process.env.VISIT_RETENTION_DAYS ?? 180) || 180);
/** A page open longer than this is a tab left behind, not a visit. */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PAGE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * The market the product serves. Visits from there are the report an
 * operator opens to; everything else is a second report, so a wave of
 * scanners from a data centre abroad never buries the customers at home.
 */
const HOME_COUNTRY = (process.env.VISIT_HOME_COUNTRY ?? 'AU').trim().toUpperCase().slice(0, 2) || 'AU';

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------- the request

/**
 * The visitor's address. The app listens on loopback behind Caddy, which
 * appends the address it saw to X-Forwarded-For; that header is believed only
 * when the connection itself came from the proxy, because anything that
 * reached a public port could have written its own. And of the header's
 * entries only the last is Caddy's: the ones before it arrived with the
 * request, from whoever sent it, and say whatever they liked.
 */
export interface AddressableRequest {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export function clientIp(req: AddressableRequest): string | null {
  const remote = req.socket?.remoteAddress ?? '';
  const header = req.headers?.['x-forwarded-for'];
  const viaProxy = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(remote);
  const entries = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const forwarded = entries[entries.length - 1] ?? '';
  const raw = viaProxy && forwarded ? forwarded : remote;
  const ip = raw.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return isIP(ip) ? ip : null;
}

interface Agent {
  device: 'desktop' | 'mobile' | 'tablet';
  browser: string;
  os: string;
  /** Crawlers, monitors and scripted clients: not visitors, never recorded. */
  bot: boolean;
}

/**
 * What kind of thing is looking, read from the user agent. Deliberately
 * coarse — a family name, not a version — because that is what the numbers
 * are for. Edge and Chrome both claim Safari, and Edge claims Chrome, so the
 * most specific claim is tested first.
 */
function describeAgent(ua: string): Agent {
  const bot = !ua || /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|go-http-client|facebookexternalhit|preview|scan/i.test(ua);
  const device: Agent['device'] = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
          : /CrOS/i.test(ua) ? 'ChromeOS'
            : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
      : /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/i.test(ua) ? 'Firefox'
          : /Chrome\/|CriOS/i.test(ua) ? 'Chrome'
            : /Safari\//i.test(ua) ? 'Safari' : 'Other';
  return { device, browser, os, bot };
}

/** Hosts a visitor passes through on the way in, not places they came from: our own, and the sign-in provider's. */
const NOT_A_SOURCE = new Set(['accounts.google.com']);

/**
 * Where the visitor came from, kept to the site and path. The query string is
 * dropped — it is where tokens and campaign junk live — and a referrer on our
 * own host, or on the sign-in provider the page bounces through, is a step in
 * our own flow, not a source.
 */
function cleanReferrer(raw: unknown, ownHost: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (host === ownHost.replace(/^www\./, '') || NOT_A_SOURCE.has(host)) return null;
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return raw.slice(0, 200);
  }
}

function cleanAttribution(raw: unknown): { source: string | null; medium: string | null; campaign: string | null } {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const clean = (value: unknown, max: number) => typeof value === 'string'
    ? [...value.trim()].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, max) || null
    : null;
  return {
    source: clean(input.source, 80)?.toLowerCase() ?? null,
    medium: clean(input.medium, 80),
    campaign: clean(input.campaign, 160),
  };
}

// ---------------------------------------------------------------- recording

/** A page-shown beacon. Anything malformed is dropped silently; analytics never answer with an error. */
export async function recordPageView(req: IncomingMessage, body: unknown, userId: string | null): Promise<string | null> {
  const b = (body ?? {}) as Record<string, unknown>;
  const visitorId = String(b.visitorId ?? '');
  const sessionId = String(b.sessionId ?? '');
  const page = String(b.page ?? '');
  if (!ID_PATTERN.test(visitorId) || !ID_PATTERN.test(sessionId) || !PAGE_PATTERN.test(page)) return null;

  const ua = String(req.headers['user-agent'] ?? '').slice(0, 400);
  const agent = describeAgent(ua);
  if (agent.bot) return null;

  const ip = clientIp(req);
  const place = await lookupPlace(ip);
  const host = String(req.headers.host ?? '').split(':')[0];
  const screen = typeof b.screen === 'string' && /^\d{2,5}x\d{2,5}$/.test(b.screen) ? b.screen : null;
  const language = typeof b.language === 'string' && /^[A-Za-z-]{2,16}$/.test(b.language) ? b.language : null;
  const timeZone = typeof b.timeZone === 'string' && /^[A-Za-z_/+-]{2,64}$/.test(b.timeZone) ? b.timeZone : null;
  const attribution = cleanAttribution(b.attribution);

  // An ignored address is the operator's own: the view is acknowledged, never kept.
  const row = await one<{ id: string }>(
    `INSERT INTO page_views (
       visitor_id, session_id, user_id, page, referrer,
       attribution_source, attribution_medium, attribution_campaign, ip,
       country_code, country, region, city, latitude, longitude,
       user_agent, device, browser, os, screen, language, time_zone
     )
     SELECT $1::text, $2::text, $3::bigint, $4::text, $5::text,
            $6::text, $7::text, $8::text, $9::inet,
            $10::text, $11::text, $12::text, $13::text, $14::double precision, $15::double precision,
            $16::text, $17::text, $18::text, $19::text, $20::text, $21::text, $22::text
      WHERE NOT EXISTS (SELECT 1 FROM ignored_addresses WHERE ip = $9::inet)
     RETURNING id::text AS id`,
    [
      visitorId, sessionId, userId, page, cleanReferrer(b.referrer, host),
      attribution.source, attribution.medium, attribution.campaign, ip,
      place.countryCode, place.country, place.region, place.city, place.latitude, place.longitude,
      ua, agent.device, agent.browser, agent.os, screen, language, timeZone,
    ],
  );
  return row?.id ?? null;
}

/**
 * A page-left beacon. The page reports its time on every hide as well as on
 * leaving, since a phone's browser often never fires the final one, so the
 * longest report wins. Only a row this visitor opened today can be closed.
 */
export async function endPageView(body: unknown): Promise<void> {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? '');
  const visitorId = String(b.visitorId ?? '');
  const duration = Math.floor(Number(b.durationMs));
  if (!/^\d{1,18}$/.test(id) || !ID_PATTERN.test(visitorId) || !Number.isFinite(duration) || duration < 0) return;
  await query(
    `UPDATE page_views
        SET duration_ms = GREATEST(COALESCE(duration_ms, 0), $3)
      WHERE id = $1 AND visitor_id = $2 AND started_at > now() - interval '1 day'`,
    [id, visitorId, Math.min(duration, MAX_DURATION_MS)],
  );
}

// ---------------------------------------------------------------- reporting

type VisitorRange = 'today' | '7d' | '30d' | '90d';
const RANGE_DAYS: Record<Exclude<VisitorRange, 'today'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function parseRange(value: string | null): VisitorRange {
  return value === 'today' || value === '30d' || value === '90d' ? value : '7d';
}

/** Visits from the home country, or from everywhere else (which includes visits with no known place). */
type VisitorMarket = 'home' | 'abroad';

export function parseMarket(value: string | null): VisitorMarket {
  return value === 'abroad' ? 'abroad' : 'home';
}

interface VisitorScope {
  range: VisitorRange;
  market: VisitorMarket;
  /** Operators' own visits are left out unless asked for: they are not customers. */
  includeAdmins: boolean;
}

async function adminUserIds(): Promise<string[]> {
  const users = await query<{ id: string; email: string }>('SELECT id::text AS id, email FROM users');
  return users.filter((user) => isAdmin(user.email)).map((user) => user.id);
}

/**
 * The WHERE clause every report query shares, with only the parameters it
 * uses: Postgres refuses a query whose text never mentions a parameter it was
 * given ("could not determine data type of parameter $1"), which is what the
 * time zone became for every range but today.
 */
async function scope(opts: VisitorScope): Promise<{ where: string; params: unknown[] }> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (opts.range === 'today') {
    params.push(RUN_TIME_ZONE);
    clauses.push(`started_at >= (date_trunc('day', now() AT TIME ZONE $${params.length}) AT TIME ZONE $${params.length})`);
  } else {
    params.push(RANGE_DAYS[opts.range]);
    clauses.push(`started_at >= now() - make_interval(days => $${params.length}::int)`);
  }
  params.push(HOME_COUNTRY);
  clauses.push(opts.market === 'home' ? `country_code = $${params.length}` : `country_code IS DISTINCT FROM $${params.length}`);
  clauses.push('NOT EXISTS (SELECT 1 FROM ignored_addresses i WHERE i.ip = page_views.ip)');
  if (!opts.includeAdmins) {
    const admins = await adminUserIds();
    if (admins.length) {
      params.push(admins);
      clauses.push(`(user_id IS NULL OR user_id <> ALL($${params.length}::bigint[]))`);
    }
  }
  return { where: clauses.join(' AND '), params };
}

// ---------------------------------------------------------------- ignored addresses

interface IgnoredAddress { ip: string; note: string | null; createdAt: string }

/** Every address whose visits are left out, oldest first. */
export async function ignoredAddresses(): Promise<IgnoredAddress[]> {
  const rows = await query<{ ip: string; note: string | null; created_at: Date }>(
    'SELECT host(ip) AS ip, note, created_at FROM ignored_addresses ORDER BY created_at, ip',
  );
  return rows.map((row) => ({ ip: row.ip, note: row.note, createdAt: new Date(row.created_at).toISOString() }));
}

/** A well-formed address to ignore, or null. */
export function parseAddress(value: unknown): string | null {
  const ip = String(value ?? '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return isIP(ip) ? ip : null;
}

export async function ignoreAddress(ip: string, note: string | null): Promise<void> {
  await query(
    `INSERT INTO ignored_addresses (ip, note) VALUES ($1, $2)
     ON CONFLICT (ip) DO UPDATE SET note = COALESCE(EXCLUDED.note, ignored_addresses.note)`,
    [ip, note?.trim().slice(0, 120) || null],
  );
}

export async function unignoreAddress(ip: string): Promise<void> {
  await query('DELETE FROM ignored_addresses WHERE ip = $1', [ip]);
}

interface Breakdown { label: string; sub: string | null; code: string | null; visitors: number; views: number; seconds: number | null }

interface VisitorReport {
  range: VisitorRange;
  market: VisitorMarket;
  /** The country the 'home' market is. */
  home: { code: string; name: string };
  timeZone: string;
  retentionDays: number;
  geoConfigured: boolean;
  totals: { visitors: number; visits: number; views: number; signedIn: number; located: number; avgSeconds: number | null };
  countries: Breakdown[];
  regions: Breakdown[];
  cities: Breakdown[];
  pages: Breakdown[];
  referrers: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  days: Array<{ day: string; visitors: number; views: number }>;
  /** Every distinct address in the market, most recently seen first. */
  addresses: {
    count: number;
    list: Array<{ ip: string; city: string | null; region: string | null; country: string | null; visits: number; views: number; lastSeenAt: string }>;
  };
}

export async function visitorReport(opts: VisitorScope): Promise<VisitorReport> {
  const { where, params } = await scope(opts);
  // At home the country is a given; abroad it is the first thing to know about a place.
  const home = opts.market === 'home';
  const breakdown = (label: string, sub: string, code: string, extra = '', views = 'count(*)') =>
    query<{ label: string | null; sub: string | null; code: string | null; visitors: number; views: number; seconds: number | null }>(
      `SELECT ${label} AS label, ${sub} AS sub, ${code} AS code,
              count(DISTINCT visitor_id)::int AS visitors, ${views}::int AS views,
              round(avg(duration_ms) / 1000)::int AS seconds
         FROM page_views WHERE ${where} ${extra}
        GROUP BY 1, 2, 3 ORDER BY visitors DESC, views DESC LIMIT 25`,
      params,
    ).then((rows) => rows.map((row) => ({ ...row, label: row.label ?? 'Unknown' })));

  const [totals, countries, regions, cities, pages, referrers, devices, browsers, days, addresses] = await Promise.all([
    one<{ visitors: number; visits: number; views: number; signed_in: number; located: number; avg_seconds: number | null }>(
      `SELECT count(DISTINCT visitor_id)::int AS visitors,
              count(DISTINCT session_id)::int AS visits,
              count(*)::int AS views,
              count(DISTINCT visitor_id) FILTER (WHERE user_id IS NOT NULL)::int AS signed_in,
              count(*) FILTER (WHERE country_code IS NOT NULL)::int AS located,
              round(avg(duration_ms) / 1000)::int AS avg_seconds
         FROM page_views WHERE ${where}`,
      params,
    ),
    breakdown('country', 'NULL', 'country_code'),
    breakdown('region', home ? 'NULL' : 'country', 'country_code', 'AND region IS NOT NULL'),
    breakdown('city', home ? 'region' : `concat_ws(', ', region, country)`, 'country_code', 'AND city IS NOT NULL'),
    breakdown('page', 'NULL', 'NULL'),
    // A source brings a visit, not a page view: the page reports it once, and it is counted once.
    breakdown(`COALESCE(attribution_source, referrer)`, 'NULL', 'NULL',
      'AND COALESCE(attribution_source, referrer) IS NOT NULL', 'count(DISTINCT session_id)'),
    breakdown('device', 'os', 'NULL'),
    breakdown('browser', 'os', 'NULL'),
    query<{ day: string; visitors: number; views: number }>(
      `SELECT to_char(started_at AT TIME ZONE $${params.length + 1}, 'YYYY-MM-DD') AS day,
              count(DISTINCT visitor_id)::int AS visitors, count(*)::int AS views
         FROM page_views WHERE ${where} GROUP BY 1 ORDER BY 1`,
      [...params, RUN_TIME_ZONE],
    ),
    // One row per address: where it last resolved to, and how much it looked.
    query<{ ip: string; city: string | null; region: string | null; country: string | null; visits: number; views: number; last_seen: Date }>(
      `SELECT host(ip) AS ip,
              (array_agg(city ORDER BY started_at DESC))[1] AS city,
              (array_agg(region ORDER BY started_at DESC))[1] AS region,
              (array_agg(country ORDER BY started_at DESC))[1] AS country,
              count(DISTINCT session_id)::int AS visits, count(*)::int AS views, max(started_at) AS last_seen
         FROM page_views WHERE ${where} AND ip IS NOT NULL
        GROUP BY host(ip) ORDER BY max(started_at) DESC LIMIT 200`,
      params,
    ),
  ]);

  return {
    range: opts.range,
    market: opts.market,
    home: { code: HOME_COUNTRY, name: countryName(HOME_COUNTRY) },
    timeZone: RUN_TIME_ZONE,
    retentionDays: RETENTION_DAYS,
    geoConfigured: geoipConfigured(),
    totals: {
      visitors: totals?.visitors ?? 0,
      visits: totals?.visits ?? 0,
      views: totals?.views ?? 0,
      signedIn: totals?.signed_in ?? 0,
      located: totals?.located ?? 0,
      avgSeconds: totals?.avg_seconds ?? null,
    },
    countries, regions, cities, pages, referrers, devices, browsers, days,
    addresses: {
      count: addresses.length,
      list: addresses.map((row) => ({
        ip: row.ip,
        city: row.city,
        region: row.region,
        country: row.country,
        visits: row.visits,
        views: row.views,
        lastSeenAt: new Date(row.last_seen).toISOString(),
      })),
    },
  };
}

interface RecentVisit {
  sessionId: string;
  visitorId: string;
  /** How many visits this visitor has made in the range, counting this one. */
  visitNumber: number;
  startedAt: string;
  endedAt: string;
  views: number;
  durationMs: number;
  pages: string[];
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  screen: string | null;
  language: string | null;
  timeZone: string | null;
  referrer: string | null;
  attributionSource: string | null;
  attributionMedium: string | null;
  attributionCampaign: string | null;
  email: string | null;
}

/** One row per visit (a browser session), newest first: the pages in order, and everything known about who was there. */
export async function recentVisits(opts: VisitorScope, limit = 150): Promise<RecentVisit[]> {
  const { where, params } = await scope(opts);
  params.push(Math.min(500, Math.max(1, limit)));
  const rows = await query<{
    session_id: string; visitor_id: string; visit_number: number; started_at: Date; ended_at: Date;
    views: number; duration_ms: number; pages: string[]; ip: string | null;
    country_code: string | null; country: string | null; region: string | null; city: string | null;
    device: string | null; browser: string | null; os: string | null; screen: string | null;
    language: string | null; time_zone: string | null; referrer: string | null;
    attribution_source: string | null; attribution_medium: string | null; attribution_campaign: string | null;
    email: string | null;
  }>(
    `WITH visits AS (
       SELECT session_id, visitor_id,
              min(started_at) AS started_at,
              max(started_at + COALESCE(duration_ms, 0) * interval '1 millisecond') AS ended_at,
              count(*)::int AS views,
              COALESCE(sum(duration_ms), 0)::int AS duration_ms,
              array_agg(page ORDER BY started_at) AS pages,
              (array_agg(host(ip) ORDER BY started_at))[1] AS ip,
              (array_agg(country_code ORDER BY started_at))[1] AS country_code,
              (array_agg(country ORDER BY started_at))[1] AS country,
              (array_agg(region ORDER BY started_at))[1] AS region,
              (array_agg(city ORDER BY started_at))[1] AS city,
              (array_agg(device ORDER BY started_at))[1] AS device,
              (array_agg(browser ORDER BY started_at))[1] AS browser,
              (array_agg(os ORDER BY started_at))[1] AS os,
              (array_agg(screen ORDER BY started_at))[1] AS screen,
              (array_agg(language ORDER BY started_at))[1] AS language,
              (array_agg(time_zone ORDER BY started_at))[1] AS time_zone,
              (array_agg(referrer ORDER BY started_at) FILTER (WHERE referrer IS NOT NULL))[1] AS referrer,
              (array_agg(attribution_source ORDER BY started_at) FILTER (WHERE attribution_source IS NOT NULL))[1] AS attribution_source,
              (array_agg(attribution_medium ORDER BY started_at) FILTER (WHERE attribution_medium IS NOT NULL))[1] AS attribution_medium,
              (array_agg(attribution_campaign ORDER BY started_at) FILTER (WHERE attribution_campaign IS NOT NULL))[1] AS attribution_campaign,
              max(user_id) AS user_id
         FROM page_views WHERE ${where}
        GROUP BY session_id, visitor_id
     )
     SELECT v.*, u.email,
            (row_number() OVER (PARTITION BY v.visitor_id ORDER BY v.started_at))::int AS visit_number
       FROM visits v LEFT JOIN users u ON u.id = v.user_id
      ORDER BY v.started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    visitorId: row.visitor_id,
    visitNumber: row.visit_number,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: new Date(row.ended_at).toISOString(),
    views: row.views,
    durationMs: row.duration_ms,
    pages: row.pages ?? [],
    ip: row.ip,
    countryCode: row.country_code,
    country: row.country,
    region: row.region,
    city: row.city,
    device: row.device,
    browser: row.browser,
    os: row.os,
    screen: row.screen,
    language: row.language,
    timeZone: row.time_zone,
    referrer: row.referrer,
    attributionSource: row.attribution_source,
    attributionMedium: row.attribution_medium,
    attributionCampaign: row.attribution_campaign,
    email: row.email,
  }));
}

// ---------------------------------------------------------------- upkeep

let maintenance: NodeJS.Timeout | null = null;

/** Removes page views past the retention period, once a day, starting shortly after boot. */
export function startVisitMaintenance(): void {
  if (maintenance) return;
  const prune = () =>
    query(`DELETE FROM page_views WHERE started_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])
      .catch((error) => console.warn('[visits] prune failed:', (error as Error).message));
  setTimeout(prune, 60_000).unref();
  maintenance = setInterval(prune, 24 * 60 * 60 * 1000);
  maintenance.unref();
}
