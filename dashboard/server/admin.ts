import { simulations } from './simulate.js';
import { previewAccountAlerts } from './alerts.js';
import { previewOperatorAlerts } from './operator-alerts.js';
import { homeRoutePort, proxySummary, routeStatus, setHomeRoutePort, setProxy, type RouteStatus } from './route.js';
import { pooledProxyFor, poolEnabled, poolReport, reconcilePool, syncPool } from './proxy-pool.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getPool, one, query } from './db/index.js';
import { currentUser, type SessionUser } from './auth.js';
import { billingStatus, isAdmin } from './billing.js';
import { adminOverridesFor, entitlementsFor, RUN_TIME_ZONE, setAdminOverrides, setAutoApplyPaused } from './entitlements.js';
import { applyEnvChanges, envReport, restartDashboard } from './env-settings.js';
import { readServerLogs, serverHealth } from './health.js';
import { pruneAllProfiles } from './profile-prune.js';
import { pruneAllTraces, TRACE_RETENTION_DAYS } from './trace-retention.js';
import { runner, readEnv, writeEnv, MAX_CONCURRENT } from './runner.js';
import { accountSetupChecks } from './setup.js';
import { readSiteState } from './seek-state.js';
import { sessionFor, stopSignin } from './signin.js';
import { startRun } from './start-run.js';
import { userDir } from './userdata.js';
import { PAID_PLANS, isPassPlanKey } from '../src/pricing.js';
import { clientIp, ignoreAddress, ignoredAddresses, parseAddress, parseMarket, parseRange, recentVisits, unignoreAddress, visitorReport } from './visits.js';
import { redditCapiHealth } from './reddit-capi.js';

/**
 * The operator's view of the whole installation: every account, every run,
 * and the controls for them.
 *
 * Every route here is refused unless the signed-in account is an admin, and
 * the check is made on each request — hiding the page is not the rule. Admin
 * actions go through the same paths the rest of the product uses (startRun,
 * the auto-apply switch, billing grants), so an operator cannot put an
 * account into a state the product itself could not produce.
 */

type Send = (body: unknown, status?: number) => void;

/** Local midnight, as the rest of the dashboard counts "today". */
const DAY_START = `(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`;

function planLabel(paid: Awaited<ReturnType<typeof billingStatus>>['paid'], admin: boolean): string {
  if (admin) return 'Admin';
  if (paid.hasActiveIntensivePass) return 'Intensive Pass';
  if (paid.hasActiveJobSearchPass) return 'Active Search';
  if (paid.hasActiveEssentialPass) return 'Essential Pass';
  return 'Free';
}

interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  /** When an admin blocked the account; null while it may sign in. */
  blockedAt: string | null;
  admin: boolean;
  plan: string;
  allowance: { freeRemaining: number; paidRemaining: number; paidExpiresAt: string | null };
  setupMissing: string[];
  resumes: number;
  boards: { seek: boolean | null; indeed: boolean | null };
  autoApply: { runsPerDay: number; usedToday: number; paused: boolean; canPause: boolean };
  /** An operator's per-account overrides for control: how many jobs a run reviews, and how many it may apply to. Null means the plan decides. */
  overrides: { evaluationsPerRun: number | null; maxApplicationsPerRun: number | null; humanizer: boolean | null };
  /**
   * Where this account's browsers go out: the loopback port its home tunnel
   * lands on, its proxy (never the password), and what the route is doing now.
   * A proxy, when set, is used instead of the home route.
   */
  route: {
    homePort: number | null;
    proxy: { address: string; username: string } | null;
    /** The address this account holds from the Webshare pool, if any. */
    pooled: string | null;
    status: RouteStatus;
  };
  applications: { total: number; week: number; today: number };
  lastRun: { startedAt: string; finishedAt: string | null; exitCode: number | null; trigger: string } | null;
  running: boolean;
  signingIn: boolean;
}

async function userRow(user: UserRecord): Promise<AdminUserRow> {
  const [billing, entitlements, overrides, setup, counts, lastRun] = await Promise.all([
    billingStatus(user.id, user.email),
    entitlementsFor(user.id, user.email),
    adminOverridesFor(user.id),
    accountSetupChecks(user.id),
    one<{ resumes: string; total: string; week: string; today: string }>(
      `SELECT
         (SELECT count(*) FROM resumes WHERE user_id = $2)::text AS resumes,
         (SELECT count(*) FROM applications WHERE user_id = $2 AND submitted_by_myasis)::text AS total,
         (SELECT count(*) FROM applications WHERE user_id = $2 AND submitted_by_myasis AND applied_at > now() - interval '7 days')::text AS week,
         (SELECT count(*) FROM applications WHERE user_id = $2 AND submitted_by_myasis AND applied_at >= ${DAY_START})::text AS today`,
      [RUN_TIME_ZONE, user.id],
    ),
    one<{ started_at: Date; finished_at: Date | null; exit_code: number | null; trigger: string }>(
      `SELECT started_at, finished_at, exit_code, trigger FROM run_starts WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [user.id],
    ),
  ]);
  const admin = isAdmin(user.email);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    createdAt: new Date(user.created_at).toISOString(),
    lastLoginAt: user.last_login_at ? new Date(user.last_login_at).toISOString() : null,
    blockedAt: user.blocked_at ? new Date(user.blocked_at).toISOString() : null,
    admin,
    plan: planLabel(billing.paid, admin),
    allowance: admin
      ? { freeRemaining: billing.free.remaining, paidRemaining: -1, paidExpiresAt: null }
      : { freeRemaining: billing.free.remaining, paidRemaining: billing.paid.remaining, paidExpiresAt: billing.paid.expiresAt },
    setupMissing: Object.values(setup).filter((check) => check.required && !check.done).map((check) => check.label),
    resumes: Number(counts?.resumes ?? 0),
    boards: {
      seek: readSiteState(user.id, 'seek')?.signedIn ?? null,
      indeed: readSiteState(user.id, 'indeed')?.signedIn ?? null,
    },
    autoApply: {
      runsPerDay: entitlements.autoRunsPerDay,
      usedToday: entitlements.autoRunsUsedToday,
      paused: entitlements.autoApplyPaused,
      canPause: entitlements.canPauseAutoApply,
    },
    overrides,
    route: {
      homePort: await homeRoutePort(user.id),
      proxy: await proxySummary(user.id),
      pooled: await pooledProxyFor(user.id, false).then((proxy) => (proxy ? `${proxy.host}:${proxy.port}` : null)),
      status: await routeStatus(user.id),
    },
    applications: { total: Number(counts?.total ?? 0), week: Number(counts?.week ?? 0), today: Number(counts?.today ?? 0) },
    lastRun: lastRun
      ? {
          startedAt: new Date(lastRun.started_at).toISOString(),
          finishedAt: lastRun.finished_at ? new Date(lastRun.finished_at).toISOString() : null,
          exitCode: lastRun.exit_code,
          trigger: lastRun.trigger,
        }
      : null,
    running: runner.stateFor(user.id).running,
    signingIn: Boolean(sessionFor(user.id)),
  };
}

type UserRecord = { id: string; email: string; name: string | null; avatar_url: string | null; created_at: Date; last_login_at: Date | null; blocked_at: Date | null };

async function findUser(id: string): Promise<UserRecord | null> {
  if (!/^\d+$/.test(id)) return null;
  return one<UserRecord>(
    'SELECT id::text AS id, email, name, avatar_url, created_at, last_login_at, blocked_at FROM users WHERE id = $1',
    [id],
  );
}

async function adminUsers(): Promise<AdminUserRow[]> {
  const users = await query<UserRecord>(
    'SELECT id::text AS id, email, name, avatar_url, created_at, last_login_at, blocked_at FROM users ORDER BY created_at DESC',
  );
  const rows: AdminUserRow[] = [];
  // One account at a time: each needs several queries, and the pool is shared with live runs.
  for (const user of users) rows.push(await userRow(user));
  return rows;
}

interface AdminRunRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  mode: string;
  trigger: string;
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number | null;
  hasLog: boolean;
  running: boolean;
}

async function adminRuns(filter: { userId?: string; limit?: number }): Promise<AdminRunRow[]> {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 150));
  const rows = await query<{
    id: string; user_id: string; email: string; name: string | null; mode: string; trigger: string;
    started_by_email: string | null; started_at: Date; finished_at: Date | null; exit_code: number | null;
    applied: number | null; log_file: string | null;
  }>(
    `SELECT r.id::text AS id, r.user_id::text AS user_id, u.email, u.name, r.mode, r.trigger,
            s.email AS started_by_email, r.started_at, r.finished_at, r.exit_code, r.applied, r.log_file
       FROM run_starts r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users s ON s.id = r.started_by
      WHERE ($1::bigint IS NULL OR r.user_id = $1::bigint)
      ORDER BY r.started_at DESC
      LIMIT $2`,
    [filter.userId && /^\d+$/.test(filter.userId) ? filter.userId : null, limit],
  );
  // Only the newest unfinished run of an account can be the one in flight.
  const seen = new Set<string>();
  return rows.map((row) => {
    const newest = !seen.has(row.user_id);
    seen.add(row.user_id);
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email,
      name: row.name,
      mode: row.mode,
      trigger: row.trigger,
      startedBy: row.started_by_email,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      exitCode: row.exit_code,
      applied: row.applied,
      hasLog: Boolean(row.log_file),
      running: newest && !row.finished_at && runner.stateFor(row.user_id).running,
    };
  });
}

async function adminOverview() {
  const [users, passes, today, week, revenue, errors, runs] = await Promise.all([
    one<{ total: string; new_week: string; active_week: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS new_week,
              count(*) FILTER (WHERE last_login_at > now() - interval '7 days')::text AS active_week
         FROM users`,
    ),
    query<{ plan_key: string; n: string }>(
      `SELECT p.plan_key, count(DISTINCT g.user_id)::text AS n
         FROM application_credit_grants g JOIN billing_purchases p ON p.id = g.purchase_id
        WHERE (g.expires_at IS NULL OR g.expires_at > now())
          AND g.credits_used < g.credits_total
          AND p.plan_key IN ('essential-pass', 'job-search-pass', 'intensive-pass')
        GROUP BY p.plan_key`,
    ),
    one<{ runs: string; applications: string }>(
      `SELECT (SELECT count(*) FROM run_starts WHERE started_at >= ${DAY_START})::text AS runs,
              (SELECT count(*) FROM applications WHERE submitted_by_myasis AND applied_at >= ${DAY_START})::text AS applications`,
      [RUN_TIME_ZONE],
    ),
    one<{ applications: string }>(
      `SELECT count(*)::text AS applications FROM applications WHERE submitted_by_myasis AND applied_at > now() - interval '7 days'`,
    ),
    one<{ month: string; total: string }>(
      // Live money only. A test-mode purchase has a cs_test_ session id and an admin grant costs nothing; neither is revenue.
      `SELECT COALESCE(sum(amount_paid) FILTER (WHERE paid_at > now() - interval '30 days'), 0)::text AS month,
              COALESCE(sum(amount_paid), 0)::text AS total
         FROM billing_purchases
        WHERE stripe_checkout_session_id LIKE 'cs_live_%'`,
    ),
    one<{ failed: string }>(
      `SELECT count(*)::text AS failed FROM run_starts WHERE started_at >= ${DAY_START} AND exit_code IS NOT NULL AND exit_code <> 0`,
      [RUN_TIME_ZONE],
    ),
    adminRuns({ limit: 40 }),
  ]);
  const byPlan = Object.fromEntries(passes.map((row) => [row.plan_key, Number(row.n)]));
  return {
    users: { total: Number(users?.total ?? 0), newThisWeek: Number(users?.new_week ?? 0), activeThisWeek: Number(users?.active_week ?? 0) },
    passes: { essential: byPlan['essential-pass'] ?? 0, jobSearch: byPlan['job-search-pass'] ?? 0, intensive: byPlan['intensive-pass'] ?? 0 },
    today: { runs: Number(today?.runs ?? 0), applications: Number(today?.applications ?? 0), failedRuns: Number(errors?.failed ?? 0) },
    week: { applications: Number(week?.applications ?? 0) },
    revenueCents: { last30Days: Number(revenue?.month ?? 0), total: Number(revenue?.total ?? 0) },
    capacity: { running: runner.activeCount(), lanes: MAX_CONCURRENT },
    // Ad conversions leave no trace in the product when they stop working, so
    // the panel says whether they are going out and how the last ones landed.
    redditCapi: redditCapiHealth(),
    recentRuns: runs,
  };
}

async function adminUserDetail(id: string) {
  const user = await findUser(id);
  if (!user) return null;
  const [row, passes, runs, applications] = await Promise.all([
    userRow(user),
    query<{ id: string; plan_key: string; amount_paid: number; paid_at: Date; credits_total: number; credits_used: number; expires_at: Date | null; granted: boolean; test: boolean }>(
      `SELECT p.id::text AS id, p.plan_key, p.amount_paid, p.paid_at, g.credits_total, g.credits_used, g.expires_at,
              (p.stripe_checkout_session_id LIKE 'cs_test_%') AS test,
              p.stripe_checkout_session_id LIKE 'admin-grant:%' AS granted
         FROM billing_purchases p JOIN application_credit_grants g ON g.purchase_id = p.id
        WHERE p.user_id = $1 ORDER BY p.paid_at DESC`,
      [id],
    ),
    adminRuns({ userId: id, limit: 25 }),
    query<{ job_id: string; title: string; company: string; platform: string; external: boolean; applied_at: Date }>(
      `SELECT job_id, title, company, platform, external, applied_at FROM applications
        WHERE user_id = $1 AND submitted_by_myasis ORDER BY applied_at DESC LIMIT 15`,
      [id],
    ),
  ]);
  return {
    ...row,
    passes: passes.map((pass) => ({
      id: pass.id,
      plan: PAID_PLANS[pass.plan_key as keyof typeof PAID_PLANS]?.name ?? pass.plan_key,
      amountPaidCents: pass.amount_paid,
      granted: pass.granted,
      /** Bought in Stripe test mode: no real money moved. */
      test: pass.test,
      paidAt: new Date(pass.paid_at).toISOString(),
      applications: { total: pass.credits_total, used: pass.credits_used },
      // Null unless the pass was ended early: passes are sold without an expiry.
      expiresAt: pass.expires_at ? new Date(pass.expires_at).toISOString() : null,
      active: (!pass.expires_at || new Date(pass.expires_at).getTime() > Date.now())
        && pass.credits_used < pass.credits_total,
    })),
    runs,
    // Not "applications": that name already holds the account's counts.
    recentApplications: applications.map((app) => ({
      jobId: app.job_id,
      title: app.title,
      company: app.company,
      platform: app.platform,
      external: app.external,
      appliedAt: new Date(app.applied_at).toISOString(),
    })),
  };
}

/** A pass given by an operator: the same grant a payment creates, at no charge, marked as a grant. */
async function grantPass(userId: string, planKey: string): Promise<void> {
  if (!isPassPlanKey(planKey)) throw new Error('Unknown pass.');
  const plan = PAID_PLANS[planKey];
  const expiresAt = new Date(Date.now() + plan.durationDays * 86_400_000);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const purchase = await client.query<{ id: string }>(
      `INSERT INTO billing_purchases (user_id, stripe_checkout_session_id, plan_key, applications_granted, amount_paid, currency, paid_at)
       VALUES ($1, $2, $3, $4, 0, 'aud', now()) RETURNING id`,
      [userId, `admin-grant:${randomUUID()}`, plan.key, plan.applications],
    );
    await client.query(
      `INSERT INTO application_credit_grants (user_id, purchase_id, credits_total, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, purchase.rows[0].id, plan.applications, expiresAt],
    );
    if (plan.employerSiteApplications > 0) {
      await client.query(
        `INSERT INTO employer_site_credit_grants (user_id, purchase_id, credits_total, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, purchase.rows[0].id, plan.employerSiteApplications, expiresAt],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Admins are named in ADMIN_EMAILS in seek-bot/.env, read on every request, so a change applies at once. */
function setAdminEmail(email: string, admin: boolean): void {
  if (process.env.ADMIN_EMAILS !== undefined) {
    throw new Error('Admins are set in the server process environment here, so they cannot be changed from the dashboard.');
  }
  const current = (readEnv().ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const target = email.trim().toLowerCase();
  const next = admin ? [...new Set([...current, target])] : current.filter((e) => e !== target);
  writeEnv({ ADMIN_EMAILS: next.join(',') });
}

/** Ends whatever the account has going: its run, its sign-in window, and every session it holds. */
async function cutOff(user: UserRecord): Promise<void> {
  if (runner.stateFor(user.id).running) runner.stop(user.id);
  if (sessionFor(user.id)) stopSignin(user.id);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
}

/**
 * Blocks or unblocks an account.
 *
 * A block keeps the row — so the same email cannot simply sign up again —
 * and takes away everything else: sessions end now, sign-in is refused, and
 * the schedule and the evening email leave the account out. Its data stays,
 * so an unblock puts it back exactly as it was.
 */
async function setBlocked(user: UserRecord, blocked: boolean): Promise<void> {
  if (blocked) await cutOff(user);
  await query('UPDATE users SET blocked_at = $2 WHERE id = $1', [user.id, blocked ? new Date() : null]);
}

/**
 * Removes an account and everything it owns, for good.
 *
 * The database rows go with the user row (every table cascades), the visit
 * records that named the account go too, and its directory — résumés,
 * knowledge, run logs, traces, the Chrome profile with its job-board
 * sessions — is destroyed rather than moved aside. Earlier deletions parked
 * their files under `deleted/`; any left there for this account are removed
 * as well, so nothing of it remains on the machine.
 */
async function deleteAccount(user: UserRecord): Promise<void> {
  await cutOff(user);
  await query('DELETE FROM page_views WHERE user_id = $1', [user.id]);
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  const dir = userDir(user.id);
  rmSync(dir, { recursive: true, force: true });
  const bin = resolve(dir, '..', '..', 'deleted');
  if (existsSync(bin)) {
    for (const entry of readdirSync(bin)) {
      if (entry.startsWith(`${user.id}-`)) rmSync(resolve(bin, entry), { recursive: true, force: true });
    }
  }
}

/** A saved run log, or the live lines of a run still going. */
async function runLog(runId: string): Promise<{ lines: Array<{ stream: string; text: string; ts: string }>; live: boolean; userId: string } | null> {
  if (!/^\d+$/.test(runId)) return null;
  const run = await one<{ user_id: string; log_file: string | null; finished_at: Date | null }>(
    'SELECT user_id::text AS user_id, log_file, finished_at FROM run_starts WHERE id = $1',
    [runId],
  );
  if (!run) return null;
  if (run.log_file) {
    const path = resolve(userDir(run.user_id), 'run-logs', basename(run.log_file));
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      return { lines, live: false, userId: run.user_id };
    }
  }
  if (!run.finished_at && runner.stateFor(run.user_id).running) {
    return { lines: runner.backlog(run.user_id, 0), live: true, userId: run.user_id };
  }
  return { lines: [], live: false, userId: run.user_id };
}

/**
 * Every /api/admin/* request. Returns false when the route is not one of
 * these, so the caller can fall through to its own 404.
 */
export async function handleAdminRequest(
  req: {
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    on: (event: string, fn: (...args: any[]) => void) => void;
  },
  res: { writeHead: (status: number, headers: Record<string, string>) => void; write: (chunk: string) => void },
  url: URL,
  send: Send,
  readBody: () => Promise<any>,
): Promise<void> {
  const actor: SessionUser | null = await currentUser(req.headers?.cookie as string | undefined);
  if (!actor) return send({ error: 'Sign in required.' }, 401);
  if (!isAdmin(actor.email)) return send({ error: 'Admins only.' }, 403);

  const path = url.pathname.replace(/^\/api\/admin/, '');
  const method = req.method ?? 'GET';
  let match: RegExpMatchArray | null;

  try {
    if (path === '/overview' && method === 'GET') return send(await adminOverview());
    if (path === '/users' && method === 'GET') return send(await adminUsers());
    if (path === '/runs' && method === 'GET') {
      return send(await adminRuns({ userId: url.searchParams.get('user') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 150) }));
    }

    if (path === '/env' && method === 'GET') return send(envReport());
    if (path === '/simulations' && method === 'GET') return send({ simulations: simulations() });
    if (path === '/alerts-preview' && method === 'GET') return send(await previewAccountAlerts());
    if (path === '/ops-alerts-preview' && method === 'GET') return send(await previewOperatorAlerts());

    if (path === '/proxies' && method === 'GET') return send(await poolReport());
    if (path === '/proxies/sync' && method === 'POST') {
      if (!poolEnabled()) return send({ error: 'Add a Webshare API key in Config first.' }, 400);
      try {
        await syncPool();
      } catch (error) {
        return send({ error: (error as Error).message }, 502);
      }
      return send(await poolReport());
    }

    if (path === '/env' && method === 'POST') {
      const body = await readBody();
      const changes = body?.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return send({ error: 'Send the changes as an object.' }, 400);
      if (Object.keys(changes).length > 200) return send({ error: 'Too many changes at once.' }, 400);
      try {
        const applied = applyEnvChanges(changes, actor.email);
        // A new Webshare key or country list is acted on now, not at the next quarter-hour.
        if ('WEBSHARE_API_KEY' in changes || 'PROXY_POOL_COUNTRIES' in changes) void syncPool().catch(() => {});
        return send({ ok: true, ...applied });
      } catch (error) {
        return send({ error: (error as Error).message }, 400);
      }
    }

    if (path === '/env/restart' && method === 'POST') {
      const result = restartDashboard(actor.email);
      return result.ok ? send({ ok: true }) : send({ error: result.error }, 409);
    }

    if (path === '/health' && method === 'GET') return send(await serverHealth());

    if (path === '/health/logs' && method === 'GET') {
      const lines = Math.max(20, Math.min(1000, Number(url.searchParams.get('lines') ?? 200) || 200));
      return send({ lines: await readServerLogs(lines) });
    }

    if (path === '/health/prune' && method === 'POST') {
      // The same daily cleanups, on demand, for an operator watching the disk fill.
      const profiles = pruneAllProfiles();
      const traces = pruneAllTraces();
      return send({ ok: true, profiles, traces, traceRetentionDays: TRACE_RETENTION_DAYS });
    }

    if (path === '/visitors' && method === 'GET') {
      // Who has been looking at the site, from where, and for how long.
      const scope = {
        range: parseRange(url.searchParams.get('range')),
        market: parseMarket(url.searchParams.get('market')),
        includeAdmins: url.searchParams.get('admins') === '1',
      };
      const [report, recent, ignored] = await Promise.all([visitorReport(scope), recentVisits(scope), ignoredAddresses()]);
      // The operator's own address, so it can be ignored in one click.
      return send({ ...report, recent, ignored, yourAddress: clientIp(req) });
    }

    if (path === '/visitors/ignored' && method === 'POST') {
      const body = await readBody();
      const ip = parseAddress(body?.ip);
      if (!ip) return send({ error: 'Enter a valid IP address.' }, 400);
      await ignoreAddress(ip, typeof body?.note === 'string' ? body.note : null);
      return send({ ok: true, ignored: await ignoredAddresses() });
    }

    if ((match = path.match(/^\/visitors\/ignored\/([0-9A-Fa-f.:]+)$/)) && method === 'DELETE') {
      const ip = parseAddress(match[1]);
      if (!ip) return send({ error: 'Enter a valid IP address.' }, 400);
      await unignoreAddress(ip);
      return send({ ok: true, ignored: await ignoredAddresses() });
    }

    if ((match = path.match(/^\/runs\/(\d+)\/log$/)) && method === 'GET') {
      const log = await runLog(match[1]);
      return log ? send(log) : send({ error: 'No such run.' }, 404);
    }

    if ((match = path.match(/^\/users\/(\d+)\/stream$/)) && method === 'GET') {
      // The same live console the account sees, for an operator watching it.
      const userId = match[1];
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const line of runner.backlog(userId, 0)) res.write(`data: ${JSON.stringify(line)}\n\n`);
      const unsubscribe = runner.subscribe(userId, (line) => res.write(`data: ${JSON.stringify(line)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    if (!(match = path.match(/^\/users\/(\d+)(?:\/([a-z-]+))?$/))) return send({ error: 'Unknown admin route.' }, 404);
    const target = await findUser(match[1]);
    if (!target) return send({ error: 'No such account.' }, 404);
    const action = match[2] ?? '';
    const self = target.id === actor.id;

    if (!action && method === 'GET') return send(await adminUserDetail(target.id));

    if (method === 'DELETE' && !action) {
      const body = await readBody();
      if (self) return send({ error: 'You cannot delete your own account here.' }, 400);
      if (isAdmin(target.email)) return send({ error: 'Remove admin access before deleting an admin account.' }, 400);
      if (String(body?.confirmEmail ?? '').trim().toLowerCase() !== target.email.toLowerCase()) {
        return send({ error: 'Type the account email exactly to confirm.' }, 400);
      }
      await deleteAccount(target);
      return send({ ok: true });
    }

    if (method !== 'POST') return send({ error: 'Unknown admin route.' }, 404);
    const body = await readBody();

    switch (action) {
      case 'limits': {
        const hasEvaluations = Object.prototype.hasOwnProperty.call(body ?? {}, 'evaluationsPerRun');
        const hasMaxApps = Object.prototype.hasOwnProperty.call(body ?? {}, 'maxApplicationsPerRun');
        const hasHomeRoute = Object.prototype.hasOwnProperty.call(body ?? {}, 'homeRoutePort');
        const hasProxy = Object.prototype.hasOwnProperty.call(body ?? {}, 'proxy');
        const hasHumanizer = Object.prototype.hasOwnProperty.call(body ?? {}, 'humanizer');
        if (!hasEvaluations && !hasMaxApps && !hasHomeRoute && !hasProxy && !hasHumanizer) return send({ error: 'Set at least one account override to change.' }, 400);
        if (hasHomeRoute && body.homeRoutePort !== null && !(Number.isInteger(body.homeRoutePort) && body.homeRoutePort >= 1024 && body.homeRoutePort <= 65535)) {
          return send({ error: 'The home route port must be a whole number from 1024 to 65535, or empty for none.' }, 400);
        }
        if (hasProxy && body.proxy !== null && typeof body.proxy !== 'string') return send({ error: 'The proxy must be text, or null for none.' }, 400);
        if (hasProxy) {
          const refused = await setProxy(target.id, body.proxy);
          if (refused) return send({ error: refused }, 400);
        }
        if (hasHomeRoute) await setHomeRoutePort(target.id, body.homeRoutePort);
        const invalid = (value: unknown) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 1);
        if (hasEvaluations && invalid(body.evaluationsPerRun)) {
          return send({ error: 'Jobs reviewed per run must be a positive number, or null to use the plan default.' }, 400);
        }
        if (hasMaxApps && invalid(body.maxApplicationsPerRun)) {
          return send({ error: 'Applications per run must be a positive number, or null to use the plan default.' }, 400);
        }
        if (hasHumanizer && body.humanizer !== null && typeof body.humanizer !== 'boolean') {
          return send({ error: 'Humanizer access must be enabled, disabled, or set to the plan default.' }, 400);
        }
        await setAdminOverrides(target.id, {
          ...(hasEvaluations ? { evaluationsPerRun: body.evaluationsPerRun } : {}),
          ...(hasMaxApps ? { maxApplicationsPerRun: body.maxApplicationsPerRun } : {}),
          ...(hasHumanizer ? { humanizer: body.humanizer } : {}),
        }, { targetIsAdmin: isAdmin(target.email) });
        return send({ ok: true, user: await userRow(target) });
      }
      case 'auto-apply': {
        if (typeof body?.enabled !== 'boolean') return send({ error: 'Say whether automatic runs should be on or off.' }, 400);
        await setAutoApplyPaused(target.id, !body.enabled);
        return send({ ok: true, user: await userRow(target) });
      }
      case 'run': {
        const result = await startRun({
          userId: target.id,
          email: target.email,
          mode: 'live',
          trigger: 'admin',
          startedBy: actor.id,
          scope: body?.scope,
          jobIds: body?.jobIds,
          externalUrl: body?.externalUrl,
        });
        return result.ok ? send({ ok: true, user: await userRow(target) }) : send({ error: result.error }, result.status);
      }
      case 'stop': {
        const result = runner.stop(target.id);
        return result.ok ? send({ ok: true }) : send({ error: result.error }, 409);
      }
      case 'grant': {
        if (!isPassPlanKey(body?.plan)) return send({ error: 'Choose a pass to give.' }, 400);
        await grantPass(target.id, body.plan);
        // A pass given is a pass paid for, as far as the account's address goes.
        await reconcilePool().catch((error) => console.warn(`[proxy-pool] reconcile failed: ${(error as Error).message}`));
        return send({ ok: true, user: await adminUserDetail(target.id) });
      }
      case 'end-passes': {
        await query('UPDATE application_credit_grants SET expires_at = now() WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())', [target.id]);
        await reconcilePool().catch((error) => console.warn(`[proxy-pool] reconcile failed: ${(error as Error).message}`));
        return send({ ok: true, user: await adminUserDetail(target.id) });
      }
      case 'sign-out': {
        const removed = await query('DELETE FROM sessions WHERE user_id = $1 RETURNING token', [target.id]);
        return send({ ok: true, sessions: removed.length });
      }
      case 'block': {
        if (typeof body?.blocked !== 'boolean') return send({ error: 'Say whether the account should be blocked.' }, 400);
        if (self) return send({ error: 'You cannot block your own account.' }, 400);
        if (isAdmin(target.email)) return send({ error: 'Remove admin access before blocking an admin account.' }, 400);
        await setBlocked(target, body.blocked);
        return send({ ok: true, user: await adminUserDetail(target.id) });
      }
      case 'admin': {
        if (typeof body?.admin !== 'boolean') return send({ error: 'Say whether this account should be an admin.' }, 400);
        if (self && !body.admin) return send({ error: 'You cannot remove your own admin access.' }, 400);
        setAdminEmail(target.email, body.admin);
        return send({ ok: true, user: await adminUserDetail(target.id) });
      }
      default:
        return send({ error: 'Unknown admin action.' }, 404);
    }
  } catch (error) {
    return send({ error: (error as Error).message }, 500);
  }
}
