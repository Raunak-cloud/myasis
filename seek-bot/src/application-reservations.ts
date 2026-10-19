import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applicationKeys, applicationFormKey, applicationUrlKey } from './application-identity.js';
import { isExternalApplicationUrl } from './job-board-url.js';
import type { AppliedRecord, ApplyOutcome, JobListing } from './types.js';

type AttemptState = 'running' | 'pending' | 'applied' | 'observed' | 'uncertain' | 'released';
interface AttemptScope { journal: ApplicationReservations; id: string; job: JobListing; beforeSubmit?: (external: boolean) => boolean }
const attemptScope = new AsyncLocalStorage<AttemptScope>();

/** Owner-local durable claims. No expiry: a crash must never silently authorize another send. */
export class ApplicationReservations {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, 'application-reservations.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, job_id TEXT NOT NULL, platform TEXT NOT NULL,
        updated_at TEXT NOT NULL, external INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id));`);
    if (!this.db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'external')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN external INTEGER NOT NULL DEFAULT 0');
    }
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private claim(id: string, keys: string[]): boolean {
    for (const key of keys) {
      const existing = this.db.prepare('SELECT attempt_id FROM claims WHERE key=?').get(key);
      if (existing && existing.attempt_id !== id) return false;
    }
    for (const key of keys) this.db.prepare('INSERT OR IGNORE INTO claims(key,attempt_id) VALUES(?,?)').run(key, id);
    return true;
  }
  acquire(job: JobListing): string | null {
    return this.transaction(() => {
      const keys = applicationKeys(job);
      if (keys.some(key => this.db.prepare('SELECT 1 FROM claims WHERE key=?').get(key))) return null;
      const id = randomUUID();
      this.db.prepare('INSERT INTO attempts(id,state,job_id,platform,updated_at,external) VALUES(?,?,?,?,?,?)')
        .run(id, 'running', job.id, job.platform ?? 'seek', new Date().toISOString(), job.applicationMode === 'external' ? 1 : 0);
      this.claim(id, keys);
      return id;
    });
  }
  /** Commit the uncertainty marker BEFORE the browser may send anything. */
  authorize(id: string, job: JobListing, formUrl: string): boolean {
    return this.transaction(() => {
      const state = this.state(id);
      if (state !== 'running') return false;
      const keys = applicationKeys(job);
      const form = applicationFormKey(job, formUrl);
      if (!form) return false;
      // Hosted review URLs sometimes omit the vacancy id. Keep their identity
      // tied to the board listing; external form URLs are shared across boards.
      const external = isExternalApplicationUrl(formUrl);
      if (external) keys.push(form);
      if (!this.claim(id, keys)) return false;
      this.db.prepare('UPDATE attempts SET state=?,updated_at=?,external=? WHERE id=?').run('pending', new Date().toISOString(), external ? 1 : 0, id);
      return true;
    });
  }
  state(id: string): AttemptState | undefined {
    return this.db.prepare('SELECT state FROM attempts WHERE id=?').get(id)?.state as AttemptState | undefined;
  }
  /** Explicit browser validation proves that send was rejected. A missing
   * receipt or a model's belief alone never releases the pending marker. */
  rejected(id: string): void {
    this.db.prepare("UPDATE attempts SET state='running',updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id);
  }
  finish(id: string, outcome?: ApplyOutcome): boolean {
    return this.transaction(() => {
      const previous = this.state(id);
      const uncertain = previous === 'pending' || outcome?.submitPressed === true;
      const state = outcome?.status === 'applied' ? 'applied' : uncertain ? 'uncertain'
        : outcome?.status === 'already-applied' ? 'observed' : 'released';
      this.db.prepare('UPDATE attempts SET state=?,updated_at=? WHERE id=?').run(state, new Date().toISOString(), id);
      if (state === 'released') this.db.prepare('DELETE FROM claims WHERE attempt_id=?').run(id);
      return uncertain || outcome?.status === 'applied';
    });
  }
  /** Recover daily allowance after a crash, without counting a confirmed
   * application again when it already exists in the exported owner history. */
  unrecordedToday(records: readonly AppliedRecord[]): { applications: number; external: number } {
    const zone = process.env.RUN_TIME_ZONE?.trim() || 'Australia/Sydney';
    const day = (at: string | number) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone });
    const today = day(Date.now());
    const recorded = new Set(records.filter(record => day(record.appliedAt) === today
      && (record.submittedByMyasis ?? (record.score > 0 || Boolean(record.coverLetter))))
      .map(record => `${record.platform}:${record.jobId}`));
    const rows = this.db.prepare("SELECT job_id,platform,updated_at,external FROM attempts WHERE state IN ('pending','applied','uncertain')").all();
    const extra = rows.filter(row => day(String(row.updated_at)) === today && !recorded.has(`${row.platform}:${row.job_id}`));
    return { applications: extra.length, external: extra.filter(row => row.external === 1).length };
  }
  close(): void { this.db.close(); }
}

export function withApplicationAttempt<T>(scope: AttemptScope, action: () => T): T { return attemptScope.run(scope, action); }

export function recordReservedRejection(): void {
  const attempt = attemptScope.getStore();
  if (attempt) attempt.journal.rejected(attempt.id);
}

/** No active coordinator means the existing single-application guard still owns submission. */
export function reservedSubmissionDecision(formUrl: string): { allowed: true } | { allowed: false; kind: 'allowance' | 'reservation' | 'invalid-url'; reason: string } {
  const attempt = attemptScope.getStore();
  if (!applicationUrlKey(formUrl)) {
    return { allowed: false, kind: 'invalid-url', reason: 'The current application address is invalid.' };
  }
  if (!attempt) return { allowed: true };
  const external = isExternalApplicationUrl(formUrl);
  if (attempt.beforeSubmit && !attempt.beforeSubmit(external)) return { allowed: false, kind: 'allowance',
    reason: external ? 'No employer-site application allowance is available for this destination.' : 'The reserved application slot is no longer available.' };
  return attempt.journal.authorize(attempt.id, attempt.job, formUrl) ? { allowed: true }
    : { allowed: false, kind: 'reservation', reason: 'This exact application is reserved, previously sent, or awaiting confirmation.' };
}

export function authorizeReservedSubmission(formUrl: string): boolean {
  return reservedSubmissionDecision(formUrl).allowed;
}
