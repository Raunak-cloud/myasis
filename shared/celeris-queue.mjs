import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';

const defaultFile = fileURLToPath(new URL('../seek-bot/data/celeris-queue.sqlite', import.meta.url));
const databases = new Map();
const integer = (raw, fallback, min, max) => {
  const n = Number(raw);
  return String(raw ?? '').trim() && Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
};

/** All models/keys for a workspace share one scope. Never identify a workspace
 * by API key: rotating/adding a key must not give it a second allowance. */
function policy(endpoint, env) {
  const label = env.CELERIS_WORKSPACE_ID?.trim() || new URL(endpoint).origin;
  const file = env.CELERIS_QUEUE_FILE?.trim() || defaultFile;
  if (!isAbsolute(file)) throw new Error('CELERIS_QUEUE_FILE must be an absolute path shared by all workers.');
  return {
    scope: createHash('sha256').update(label).digest('hex'),
    file: resolve(file),
    concurrency: integer(env.CELERIS_MAX_CONCURRENT_REQUESTS, 2, 1, 32),
    interval: integer(env.CELERIS_MIN_INTERVAL_MS, 100, 0, 60_000),
  };
}

function database(file) {
  if (databases.has(file)) return databases.get(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS celeris_workspaces (
        scope TEXT PRIMARY KEY, next_start REAL NOT NULL DEFAULT 0, blocked_until REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS celeris_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, scope TEXT NOT NULL,
        state TEXT NOT NULL, expires REAL NOT NULL, max_active INTEGER NOT NULL, interval_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS celeris_requests_scope ON celeris_requests(scope,state,seq);`);
    chmodSync(file, 0o600);
  } catch (error) { db.close(); throw error; }
  databases.set(file, db);
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class CelerisQueueDeadlineError extends Error {
  constructor() { super('Celeris request queue deadline exceeded; no new request was sent.'); }
}

/** FIFO admission shared by separate Node processes on this server. Only
 * opaque tickets/times live on disk; no prompts, profiles or API keys do.
 * Active tickets outlive the request deadline briefly, recovering after a
 * crashed worker without immediately replacing an upstream in-flight call. */
export async function acquireCelerisPermit({ endpoint, deadline, leaseMs = deadline - Date.now(), env = process.env, signal }) {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new CelerisQueueDeadlineError();
  signal?.throwIfAborted();
  const p = policy(endpoint, env), db = database(p.file), id = randomUUID();
  transaction(db, () => {
    db.prepare('DELETE FROM celeris_requests WHERE expires <= ?').run(Date.now());
    const { n } = db.prepare('SELECT COUNT(*) n FROM celeris_requests WHERE scope=?').get(p.scope);
    if (n >= 256) throw new Error('Celeris request queue is full; try again later.');
    db.prepare('INSERT OR IGNORE INTO celeris_workspaces(scope) VALUES (?)').run(p.scope);
    db.prepare(`INSERT INTO celeris_requests(id,scope,state,expires,max_active,interval_ms)
      VALUES (?,?,'waiting',?,?,?)`).run(id, p.scope, deadline, p.concurrency, p.interval);
  });
  let granted = false;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      granted = transaction(db, () => {
        const now = Date.now();
        db.prepare('DELETE FROM celeris_requests WHERE expires <= ?').run(now);
        const first = db.prepare("SELECT id FROM celeris_requests WHERE scope=? AND state='waiting' ORDER BY seq LIMIT 1").get(p.scope);
        if (first?.id !== id) return false;
        const state = db.prepare('SELECT next_start,blocked_until FROM celeris_workspaces WHERE scope=?').get(p.scope);
        if (Math.max(state.next_start, state.blocked_until) > now) return false;
        // Mixed process settings use the stricter policy until those tickets
        // finish; an older worker cannot accidentally bypass a lowered cap.
        const limits = db.prepare('SELECT MIN(max_active) cap,MAX(interval_ms) spacing FROM celeris_requests WHERE scope=?').get(p.scope);
        const { n } = db.prepare("SELECT COUNT(*) n FROM celeris_requests WHERE scope=? AND state='active'").get(p.scope);
        if (n >= limits.cap) return false;
        db.prepare("UPDATE celeris_requests SET state='active',expires=? WHERE id=?").run(Math.min(deadline, now + Math.max(1, leaseMs)) + 5000, id);
        db.prepare('UPDATE celeris_workspaces SET next_start=? WHERE scope=?').run(now + limits.spacing, p.scope);
        return true;
      });
      if (granted) break;
      await pause(Math.min(75 + Math.floor(Math.random() * 50), deadline - Date.now()), undefined, { signal });
    }
    if (!granted) throw new CelerisQueueDeadlineError();
  } finally {
    if (!granted) db.prepare('DELETE FROM celeris_requests WHERE id=?').run(id);
  }
  if (Date.now() >= deadline || signal?.aborted) {
    db.prepare('DELETE FROM celeris_requests WHERE id=?').run(id);
    signal?.throwIfAborted();
    throw new CelerisQueueDeadlineError();
  }
  let released = false;
  return {
    release() {
      if (released) return;
      db.prepare('DELETE FROM celeris_requests WHERE id=?').run(id);
      released = true;
    },
    defer(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid Celeris cooldown.');
      // A 429 pauses the whole workspace, including requests in other workers.
      db.prepare('UPDATE celeris_workspaces SET blocked_until=MAX(blocked_until,?) WHERE scope=?').run(Date.now() + ms, p.scope);
    },
  };
}

/** Retry-After can be delta seconds or an HTTP date. Never shorten the server's
 * delay to fit our deadline: the caller must give up rather than retry early. */
export function celerisRetryDelay(retryAfter, attempt, now = Date.now(), random = Math.random) {
  let floor = 0;
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    const parsed = /^[\d.]+$/.test(retryAfter.trim()) && Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(parsed)) floor = Math.max(0, parsed - now);
  }
  const ceiling = Math.min(10_000, 700 * 2 ** Math.min(8, Math.max(0, attempt)));
  return Math.ceil(floor + Math.max(0, Math.min(1, random())) * ceiling);
}

export async function waitForCelerisRetry(ms, deadline) {
  if (!Number.isFinite(ms) || Date.now() + ms >= deadline) throw new CelerisQueueDeadlineError();
  await pause(ms);
}

/** Close handles after all callers have drained (tests or graceful shutdown).
 * Tickets remain durable: closing a handle never grants another allowance. */
export function closeCelerisQueues() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
