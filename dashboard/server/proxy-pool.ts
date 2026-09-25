import { getPool, one, query } from './db/index.js';
import { readEnv } from './runner.js';
import { isAdmin } from './billing.js';
import { endpointOf, isPublic, parseProxy } from './proxy-address.js';

/**
 * A dedicated address for every paying account, plus short-lived loans to
 * free accounts while they work toward their next successful application,
 * from the operator's Webshare plans.
 *
 * The pool is kept declaratively. Paying accounts with applications left hold
 * one working proxy in the pool's countries. A free account may temporarily
 * borrow an otherwise-free one when a live run opens, and returns it after a
 * confirmed submission. Reconciliation runs when a payment lands, every few
 * minutes, and just before a browser opens, so an account with no proxy simply
 * goes out from the server, as every account did before.
 *
 * What is in the pool comes from Webshare itself (`GET /api/v2/proxy/list/`,
 * for every active static residential plan), synced on a timer. Webshare can
 * swap a proxy for another — by hand in its dashboard, or automatically when
 * one fails — and reports each swap (`GET /api/v2/proxy/list/replaced/`), so
 * an account whose proxy was swapped moves to its replacement rather than to
 * a stranger's.
 *
 * An address is an identity to a job board, so assignments are sticky: an
 * account that stops paying and comes back is given its old address if it is
 * still free, and an address given up is not handed to another account until
 * it has cooled down, so two accounts are never seen from one address at once.
 * Proxies an operator has typed in for a particular account are never pooled.
 */

const API = 'https://proxy.webshare.io/api/v2';
/** Webshare's name for static residential ("ISP") proxies. Rotating residential has no fixed address to give. */
const POOL_SUBTYPES = new Set(['isp']);
const SYNC_EVERY_MS = 15 * 60_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
/** Longer than any run, so an address is never shared by two accounts' browsers. */
export const COOLDOWN_MS = 3 * 60 * 60_000;
/** Last-resort cleanup after a crash or restart misses the normal run-finished release. */
const FREE_LOAN_MAX_MS = 2 * 60 * 60_000;
const MANUAL_PROXY_KEY = 'ADMIN_PROXY_URL';

function env(key: string): string {
  return (process.env[key] ?? readEnv()[key] ?? '').trim();
}

export function poolEnabled(): boolean {
  return env('WEBSHARE_API_KEY').length > 0;
}

/** Countries whose proxies may be given out. Two-letter codes; Australia unless the operator says otherwise. */
function poolCountries(): string[] {
  const listed = env('PROXY_POOL_COUNTRIES').split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
  return listed.length ? listed : ['AU'];
}

// ---------------------------------------------------------------- the rule, as pure functions

export interface PoolRow {
  id: string;
  planId: string;
  address: string;
  port: number;
  username: string;
  password: string;
  countryCode: string | null;
  city: string | null;
  valid: boolean;
  userId: string | null;
  lastUserId: string | null;
  releasedAt: Date | null;
}

export type FetchedProxy = Omit<PoolRow, 'userId' | 'lastUserId' | 'releasedAt'>;

/** One swap Webshare made: the proxy at `from` (host:port) now lives at `to`. */
interface Replacement {
  from: string;
  to: string;
}

interface SyncPlan {
  upsert: FetchedProxy[];
  remove: string[];
  /** An account whose proxy was swapped, onto the proxy that replaced it. */
  moves: Array<{ userId: string; to: string }>;
  /** Accounts whose address or login changed: their next browser must pick it up. */
  changed: string[];
}

/** What a fresh list from Webshare means for the pool. */
export function planSync(rows: PoolRow[], fetched: FetchedProxy[], replacements: Replacement[]): SyncPlan {
  const fetchedById = new Map(fetched.map((proxy) => [proxy.id, proxy]));
  const fetchedByEndpoint = new Map(fetched.map((proxy) => [endpointOf({ host: proxy.address, port: proxy.port }), proxy]));
  const swappedTo = new Map(replacements.map((swap) => [swap.from, swap.to]));
  const heldAfter = new Set(rows.filter((row) => row.userId && fetchedById.has(row.id)).map((row) => row.id));
  const plan: SyncPlan = { upsert: fetched, remove: [], moves: [], changed: [] };

  for (const row of rows) {
    const now = fetchedById.get(row.id);
    if (now) {
      const same = now.address === row.address && now.port === row.port && now.username === row.username && now.password === row.password;
      if (row.userId && !same) plan.changed.push(row.userId);
      continue;
    }
    plan.remove.push(row.id);
    if (!row.userId) continue;
    plan.changed.push(row.userId);
    // Follow the swap, and a swap of the swap, to where the proxy is now.
    let at = endpointOf({ host: row.address, port: row.port });
    for (let hop = 0; hop < 5 && !fetchedByEndpoint.has(at) && swappedTo.has(at); hop++) at = swappedTo.get(at)!;
    const target = fetchedByEndpoint.get(at);
    if (target && !heldAfter.has(target.id)) {
      plan.moves.push({ userId: row.userId, to: target.id });
      heldAfter.add(target.id);
    }
  }
  return plan;
}

interface AssignPlan {
  release: string[];
  assign: Array<{ proxyId: string; userId: string }>;
  /** Paying accounts the pool had nothing for. */
  waiting: string[];
}

/**
 * Who should hold which proxy. `entitled` is in the order accounts started
 * paying, so when the pool runs short the earliest customers are served first.
 * `reserved` holds the endpoints operators have typed in for particular accounts.
 */
export function planPool(
  rows: PoolRow[],
  entitled: string[],
  reserved: Set<string>,
  options: { countries: string[]; now: number; cooldownMs: number },
): AssignPlan {
  const plan: AssignPlan = { release: [], assign: [], waiting: [] };
  const wanted = new Set(entitled);
  const holding = new Set<string>();
  const free: PoolRow[] = [];
  for (const row of rows) {
    const endpoint = endpointOf({ host: row.address, port: row.port });
    if (row.userId && (!wanted.has(row.userId) || reserved.has(endpoint) || holding.has(row.userId))) {
      plan.release.push(row.id);
      continue; // just given up: cooling down, so not offered to anyone else in this pass
    }
    if (row.userId) {
      holding.add(row.userId);
      continue;
    }
    if (row.valid && row.countryCode && options.countries.includes(row.countryCode.toUpperCase()) && !reserved.has(endpoint)) free.push(row);
  }

  for (const userId of entitled) {
    if (holding.has(userId)) continue;
    const usable = free.filter((row) => row.lastUserId === userId || !row.releasedAt || options.now - row.releasedAt.getTime() >= options.cooldownMs);
    usable.sort((a, b) => rank(a, userId) - rank(b, userId) || (a.releasedAt?.getTime() ?? 0) - (b.releasedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
    const pick = usable[0];
    if (!pick) {
      plan.waiting.push(userId);
      continue;
    }
    plan.assign.push({ proxyId: pick.id, userId });
    free.splice(free.indexOf(pick), 1);
    holding.add(userId);
  }
  return plan;
}

/** Its own old address first, then one never used, then the one given up longest ago. */
function rank(row: PoolRow, userId: string): number {
  if (row.lastUserId === userId) return 0;
  return row.releasedAt ? 2 : 1;
}

// ---------------------------------------------------------------- Webshare

interface WebsharePage<T> {
  next: string | null;
  results: T[];
}

async function webshare<T>(url: string, key: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Token ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Webshare refused the API key.');
  // Its limit is 60 list requests a minute; the next sync is minutes away.
  if (response.status === 429) throw new Error('Webshare is rate limiting this server; the next sync will try again.');
  if (!response.ok) throw new Error(`Webshare answered ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
  return (await response.json()) as T;
}

/** Every page of a list. The key is only ever sent to Webshare, whatever a `next` link says. */
async function allPages<T>(path: string, key: string, maxPages = 50): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = `${API}${path}`;
  for (let page = 0; url && page < maxPages; page++) {
    if (!url.startsWith(`${API}/`)) throw new Error('Webshare pointed the next page somewhere else.');
    const body: WebsharePage<T> = await webshare<WebsharePage<T>>(url, key);
    results.push(...body.results);
    url = body.next;
  }
  return results;
}

interface WebsharePlan {
  id: number;
  status: string;
  proxy_type: string;
  proxy_subtype: string;
}

interface WebshareProxy {
  id: string | number;
  username: string;
  password: string;
  proxy_address: string | null;
  port: number;
  valid: boolean;
  country_code: string | null;
  city_name: string | null;
}

interface WebshareReplacement {
  proxy: string;
  proxy_port: number;
  replaced_with: string;
  replaced_with_port: number;
}

async function fetchPool(key: string, vanishedEndpoints: () => Promise<Set<string>>): Promise<{ proxies: FetchedProxy[]; replacements: Replacement[]; plans: PlanSeen[] }> {
  const active = (await allPages<WebsharePlan>('/subscription/plan/?page_size=100', key)).filter((plan) => plan.status === 'active');
  const plans = active.filter((plan) => POOL_SUBTYPES.has(plan.proxy_subtype));
  const seen = active.map((plan) => ({ id: String(plan.id), type: plan.proxy_type, subtype: plan.proxy_subtype, pooled: POOL_SUBTYPES.has(plan.proxy_subtype) }));
  const proxies: FetchedProxy[] = [];
  for (const plan of plans) {
    const listed = await allPages<WebshareProxy>(`/proxy/list/?mode=direct&page_size=100&plan_id=${plan.id}`, key);
    for (const proxy of listed) {
      // Only a proxy with its own public address can be an account's address.
      if (!proxy.proxy_address || !isPublic(proxy.proxy_address) || typeof parseProxy(`${proxy.proxy_address}:${proxy.port}:${proxy.username}:${proxy.password}`) === 'string') continue;
      proxies.push({
        id: String(proxy.id),
        planId: String(plan.id),
        address: proxy.proxy_address,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        countryCode: proxy.country_code,
        city: proxy.city_name,
        valid: Boolean(proxy.valid),
      });
    }
  }

  // The swap history is only read when an account's proxy has gone missing.
  const listed = new Set(proxies.map((proxy) => endpointOf({ host: proxy.address, port: proxy.port })));
  const missing = [...(await vanishedEndpoints())].filter((endpoint) => !listed.has(endpoint));
  const replacements: Replacement[] = [];
  if (missing.length) {
    for (const plan of plans) {
      const swaps = await allPages<WebshareReplacement>(`/proxy/list/replaced/?page_size=100&plan_id=${plan.id}`, key, 20);
      for (const swap of swaps) {
        replacements.push({ from: endpointOf({ host: swap.proxy, port: swap.proxy_port }), to: endpointOf({ host: swap.replaced_with, port: swap.replaced_with_port }) });
      }
    }
  }
  return { proxies, replacements, plans: seen };
}

/** An active Webshare plan, and whether its proxies are pooled. Shown so a plan left out is never a mystery. */
interface PlanSeen {
  id: string;
  type: string;
  subtype: string;
  pooled: boolean;
}

// ---------------------------------------------------------------- the database

interface DbRow {
  id: string;
  plan_id: string;
  address: string;
  port: number;
  username: string;
  password: string;
  country_code: string | null;
  city: string | null;
  valid: boolean;
  user_id: string | null;
  borrowed_free: boolean;
  last_user_id: string | null;
  released_at: Date | null;
}

const toRow = (row: DbRow): PoolRow => ({
  id: row.id,
  planId: row.plan_id,
  address: row.address,
  port: row.port,
  username: row.username,
  password: row.password,
  countryCode: row.country_code,
  city: row.city,
  valid: row.valid,
  userId: row.user_id,
  lastUserId: row.last_user_id,
  releasedAt: row.released_at,
});

const SELECT_ROWS = `SELECT id, plan_id, address, port, username, password, country_code, city, valid,
                            user_id::text AS user_id, borrowed_free,
                            last_user_id::text AS last_user_id, released_at
                       FROM pool_proxies`;

type Client = { query: <T extends object>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };

/** The pool's queries outside a transaction, for reading. */
const direct: Client = { query: async <T extends object>(text: string, params?: unknown[]) => ({ rows: (await query(text, params ?? [])) as unknown as T[] }) };

/**
 * Accounts with paid applications left, oldest customer first. Operators are
 * left out (they are not customers), and so is any account an operator has
 * given a proxy by hand: it already has its address.
 */
async function entitledAccounts(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ id: string; email: string }>(
    `SELECT u.id::text AS id, u.email
       FROM users u
       JOIN application_credit_grants g ON g.user_id = u.id
       JOIN billing_purchases p ON p.id = g.purchase_id
      WHERE u.blocked_at IS NULL
        AND g.credits_used < g.credits_total
        AND (g.expires_at IS NULL OR g.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.user_id = u.id AND s.key = $1 AND s.value <> '')
      GROUP BY u.id, u.email
      ORDER BY min(p.paid_at), u.id`,
    [MANUAL_PROXY_KEY],
  );
  return rows.filter((row) => !isAdmin(row.email)).map((row) => row.id);
}

/** Endpoints operators have typed in for particular accounts, with who holds each. */
async function manualProxies(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ user_id: string; value: string }>(
    `SELECT user_id::text AS user_id, value FROM settings WHERE key = $1 AND value <> ''`,
    [MANUAL_PROXY_KEY],
  );
  const held = new Map<string, string>();
  for (const row of rows) {
    const proxy = parseProxy(row.value);
    if (typeof proxy !== 'string') held.set(endpointOf(proxy), row.user_id);
  }
  return held;
}

const listeners = new Set<(userId: string) => void>();

/** Told of every account whose pooled proxy was given, taken back, moved or changed. */
export function onPoolChange(listener: (userId: string) => void): void {
  listeners.add(listener);
}

function announce(userIds: Iterable<string>): void {
  for (const userId of new Set(userIds)) for (const listener of listeners) listener(userId);
}

/** Runs `work` with the pool to itself: one sync or reconcile at a time, across every caller. */
async function exclusively<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('proxy-pool'))`);
    const result = await work(client as unknown as Client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyAssignments(client: Client, borrowFor: string | null = null): Promise<{ changed: string[]; waiting: string[] }> {
  const dbRows = (await client.query<DbRow>(`${SELECT_ROWS} ORDER BY id`)).rows;
  const rows = dbRows.map(toRow);
  const paid = await entitledAccounts(client);
  const paidSet = new Set(paid);
  // A free loan survives ordinary reconciles until a confirmed application
  // releases it. If the account buys applications in the meantime, the same
  // address simply becomes its dedicated paid assignment.
  const borrowed = dbRows
    .filter((row) => row.borrowed_free && row.user_id && !paidSet.has(row.user_id))
    .map((row) => row.user_id!);
  if (paid.length) {
    await client.query(`UPDATE pool_proxies SET borrowed_free = false WHERE borrowed_free AND user_id::text = ANY($1)`, [paid]);
  }
  const entitled = [...paid, ...borrowed];
  if (borrowFor && !paidSet.has(borrowFor) && !entitled.includes(borrowFor)) entitled.push(borrowFor);
  const reserved = new Set((await manualProxies(client)).keys());
  const plan = planPool(rows, entitled, reserved, { countries: poolCountries(), now: Date.now(), cooldownMs: COOLDOWN_MS });
  const changed: string[] = [];
  if (plan.release.length) {
    const released = await client.query<{ last_user_id: string }>(
      `UPDATE pool_proxies SET last_user_id = user_id, user_id = NULL, borrowed_free = false, released_at = now()
        WHERE id = ANY($1) RETURNING last_user_id::text AS last_user_id`,
      [plan.release],
    );
    changed.push(...released.rows.map((row) => row.last_user_id));
  }
  for (const { proxyId, userId } of plan.assign) {
    await client.query(
      `UPDATE pool_proxies SET user_id = $1, borrowed_free = $2, assigned_at = now() WHERE id = $3 AND user_id IS NULL`,
      [userId, userId === borrowFor && !paidSet.has(userId), proxyId],
    );
    changed.push(userId);
  }
  // The operator-facing waiting list is a paid-customer promise. A free run
  // simply falls back to the server when every safe pool address is occupied.
  return { changed, waiting: plan.waiting.filter((userId) => paidSet.has(userId)) };
}

// ---------------------------------------------------------------- what the rest of the server calls

interface PoolState {
  lastSyncAt: string | null;
  lastSyncError: string | null;
  plans: PlanSeen[];
  /** Paying accounts the pool had nothing for at the last reconcile. */
  waiting: string[];
}

const state: PoolState = { lastSyncAt: null, lastSyncError: null, plans: [], waiting: [] };

export function poolState(): PoolState {
  return { ...state, plans: [...state.plans], waiting: [...state.waiting] };
}

/** Makes the assignments match the rule. Database only, so cheap enough to call before any browser opens. */
export async function reconcilePool(): Promise<void> {
  if (!poolEnabled()) return;
  const { changed, waiting } = await exclusively(applyAssignments);
  if (waiting.length && waiting.join() !== state.waiting.join()) {
    console.warn(`[proxy-pool] ${waiting.length} paying account(s) have no proxy: the pool has none free in ${poolCountries().join(', ')}. They apply from the server until one is added.`);
  }
  state.waiting = waiting;
  announce(changed);
}

/** Brings the pool up to what Webshare says the operator owns, then reconciles. */
export async function syncPool(): Promise<void> {
  const key = env('WEBSHARE_API_KEY');
  if (!key) return;
  try {
    const fetched = await fetchPool(key, async () => {
      const held = await query<{ address: string; port: number }>(`SELECT address, port FROM pool_proxies WHERE user_id IS NOT NULL`);
      return new Set(held.map((row) => endpointOf({ host: row.address, port: row.port })));
    });
    const changed = await exclusively(async (client) => {
      const dbRows = (await client.query<DbRow>(SELECT_ROWS)).rows;
      const rows = dbRows.map(toRow);
      const borrowedByUser = new Map(
        dbRows.filter((row) => row.user_id).map((row) => [row.user_id!, row.borrowed_free]),
      );
      const plan = planSync(rows, fetched.proxies, fetched.replacements);
      for (const proxy of plan.upsert) {
        await client.query(
          `INSERT INTO pool_proxies (id, plan_id, address, port, username, password, country_code, city, valid, seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           ON CONFLICT (id) DO UPDATE SET plan_id = EXCLUDED.plan_id, address = EXCLUDED.address, port = EXCLUDED.port,
             username = EXCLUDED.username, password = EXCLUDED.password, country_code = EXCLUDED.country_code,
             city = EXCLUDED.city, valid = EXCLUDED.valid, seen_at = now()`,
          [proxy.id, proxy.planId, proxy.address, proxy.port, proxy.username, proxy.password, proxy.countryCode, proxy.city, proxy.valid],
        );
      }
      if (plan.remove.length) await client.query(`DELETE FROM pool_proxies WHERE id = ANY($1)`, [plan.remove]);
      for (const move of plan.moves) {
        await client.query(
          `UPDATE pool_proxies SET user_id = $1, borrowed_free = $2, assigned_at = now() WHERE id = $3 AND user_id IS NULL`,
          [move.userId, borrowedByUser.get(move.userId) ?? false, move.to],
        );
      }
      const assigned = await applyAssignments(client);
      state.waiting = assigned.waiting;
      return [...plan.changed, ...assigned.changed];
    });
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncError = null;
    state.plans = fetched.plans;
    announce(changed);
  } catch (error) {
    state.lastSyncError = (error as Error).message;
    console.warn(`[proxy-pool] sync failed: ${state.lastSyncError}`);
    throw error;
  }
}

interface PooledProxy {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * The proxy this account holds from the pool, if any. With `assign`, an
 * entitled paid account is brought up to date before its browser opens. With
 * `borrowFree`, a free account may also take an otherwise-available address.
 */
export async function pooledProxyFor(userId: string, assign: boolean, borrowFree = false): Promise<PooledProxy | null> {
  if (!poolEnabled()) return null;
  const find = () => one<{ address: string; port: number; username: string; password: string }>(
    `SELECT address, port, username, password FROM pool_proxies WHERE user_id = $1`,
    [userId],
  );
  let row = await find();
  if (!row && assign) {
    if (borrowFree) {
      const result = await exclusively((client) => applyAssignments(client, userId));
      state.waiting = result.waiting;
      announce(result.changed);
    } else {
      await reconcilePool().catch((error) => console.warn(`[proxy-pool] reconcile failed: ${(error as Error).message}`));
    }
    row = await find();
  }
  return row ? { host: row.address, port: row.port, username: row.username, password: row.password } : null;
}

/**
 * Gives back only a temporary free-plan loan. Paid assignments and proxies an
 * operator entered by hand are untouched. The normal cooldown still applies,
 * so two candidates never appear from the same address at the same time.
 */
export async function releaseFreeProxy(userId: string): Promise<boolean> {
  if (!poolEnabled()) return false;
  const released = await exclusively(async (client) => {
    const row = await client.query<{ id: string }>(
      `UPDATE pool_proxies
          SET last_user_id = user_id, user_id = NULL, borrowed_free = false, released_at = now()
        WHERE user_id = $1 AND borrowed_free
        RETURNING id`,
      [userId],
    );
    return row.rows.length > 0;
  });
  if (released) announce([userId]);
  return released;
}

/**
 * Returns abandoned free loans after their maximum lifetime. Active runs are
 * excluded even if they run unusually long; their normal finish callback will
 * return the loan. This is the restart/crash backstop, not the usual path.
 */
async function releaseStaleFreeProxies(activeUserIds: Iterable<string> = []): Promise<string[]> {
  if (!poolEnabled()) return [];
  const active = [...new Set(activeUserIds)];
  const released = await exclusively(async (client) => {
    const rows = await client.query<{ last_user_id: string }>(
      `UPDATE pool_proxies
          SET last_user_id = user_id, user_id = NULL, borrowed_free = false, released_at = now()
        WHERE borrowed_free
          AND (assigned_at IS NULL OR assigned_at < now() - ($1::bigint * interval '1 millisecond'))
          AND NOT (user_id::text = ANY($2::text[]))
        RETURNING last_user_id::text AS last_user_id`,
      [FREE_LOAN_MAX_MS, active],
    );
    return rows.rows.map((row) => row.last_user_id);
  });
  if (released.length) {
    console.warn(`[proxy-pool] returned ${released.length} stale free proxy loan(s)`);
    announce(released);
  }
  return released;
}

/** Who holds the proxy at this endpoint, if the pool has given it out. */
export async function poolHolderOf(endpoint: string): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM pool_proxies WHERE user_id IS NOT NULL AND lower(address) || ':' || port = $1`,
    [endpoint],
  );
  return row?.user_id ?? null;
}

interface PoolReport extends PoolState {
  enabled: boolean;
  countries: string[];
  proxies: Array<{
    id: string;
    address: string;
    countryCode: string | null;
    city: string | null;
    valid: boolean;
    holder: string | null;
    reservedFor: string | null;
    coolingUntil: string | null;
  }>;
  waitingEmails: string[];
}

/** The pool as the operator sees it. Never a password. */
export async function poolReport(): Promise<PoolReport> {
  const rows = (await query<DbRow & { email: string | null }>(
    `SELECT p.id, p.plan_id, p.address, p.port, p.username, p.password, p.country_code, p.city, p.valid,
            p.user_id::text AS user_id, p.last_user_id::text AS last_user_id, p.released_at, u.email
       FROM pool_proxies p LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.user_id IS NULL, p.country_code, p.address`,
  ));
  const manual = await manualProxies(direct);
  const emails = new Map((await query<{ id: string; email: string }>(`SELECT id::text AS id, email FROM users WHERE id::text = ANY($1)`, [[...manual.values(), ...state.waiting]])).map((row) => [row.id, row.email]));
  return {
    ...state,
    enabled: poolEnabled(),
    countries: poolCountries(),
    proxies: rows.map((row) => {
      const reservedBy = manual.get(endpointOf({ host: row.address, port: row.port }));
      const coolsAt = row.released_at ? new Date(row.released_at).getTime() + COOLDOWN_MS : 0;
      return {
        id: row.id,
        address: `${row.address}:${row.port}`,
        countryCode: row.country_code,
        city: row.city,
        valid: row.valid,
        holder: row.email,
        reservedFor: reservedBy ? (emails.get(reservedBy) ?? `account ${reservedBy}`) : null,
        coolingUntil: !row.user_id && coolsAt > Date.now() ? new Date(coolsAt).toISOString() : null,
      };
    }),
    waitingEmails: state.waiting.map((id) => emails.get(id) ?? `account ${id}`),
  };
}

let started = false;

export function startProxyPool(activeUserIds: () => Iterable<string> = () => []): void {
  if (started) return;
  started = true;
  const sync = () => void syncPool().catch(() => {});
  const reconcile = () => void releaseStaleFreeProxies(activeUserIds())
    .then(() => reconcilePool())
    .catch((error) => console.warn(`[proxy-pool] reconcile failed: ${(error as Error).message}`));
  setTimeout(reconcile, 5_000).unref();
  setTimeout(sync, 30_000).unref();
  setInterval(sync, SYNC_EVERY_MS).unref();
  setInterval(reconcile, RECONCILE_EVERY_MS).unref();
}
