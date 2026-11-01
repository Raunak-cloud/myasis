import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hostOf, type SiteCredential } from './site-auth.js';

/**
 * How each employer-site account's password was made: its format and the
 * site's rules, never the password. Kept with the account's data so a later
 * run signs in with the same password and the dashboard can show it.
 */
const FILE = () => resolve(config.dataDir, 'site-credentials.json');
const key = (url: string, email: string) => `${hostOf(url)}|${email.trim().toLowerCase()}`;
export type CredentialPurpose = 'create_account' | 'reset_password';
type PendingCredential = SiteCredential & { purpose: CredentialPurpose; phase: 'prepared' | 'needs_verification'; at: string };
const pendingFile = () => resolve(config.dataDir, 'pending-site-credentials.json');
// Shared ATS hosts serve several employers. Pending recovery must also match
// the employer, rather than adopting another tenant's unverified proposal.
const pendingKey = (url: string, email: string, employer: string, purpose: CredentialPurpose) =>
  JSON.stringify([hostOf(url), email.trim().toLowerCase(), employer.trim().toLowerCase().replace(/\s+/g, ' '), purpose]);

function readRecords<T>(file: string): Record<string, T> {
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private credential metadata. Preserve the file for recovery.');
  return value;
}

function writeRecords(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Atomic rename protects readers, not concurrent read/modify/write cycles.
 * A short owner-local SQLite write transaction serializes all credential
 * mutations across processes and is automatically released after a crash.
 * The existing JSON format remains readable by the candidate dashboard. */
function mutate<T>(action: () => T): T {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(config.dataDir, 'site-credentials-lock.sqlite');
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function pendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose): PendingCredential | null {
  const value = readRecords<PendingCredential>(pendingFile())[pendingKey(url, email, employer, purpose)];
  return value?.format === 'readable-v1' && value.purpose === purpose
    && ['prepared', 'needs_verification'].includes(value.phase) ? value : null;
}

/** Durable proposals are not accepted credentials and never authorize sign-in. */
export function stagePendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose, credential: SiteCredential): PendingCredential {
 return mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingKey(url, email, employer, purpose);
  const previous = pendingCredential(url, email, employer, purpose);
  // An accepted registration awaiting activation already has a password.
  // Reopening registration must not silently replace that proposed password.
  const value: PendingCredential = purpose === 'create_account' && previous?.phase === 'needs_verification' ? previous
    : { format: credential.format, rules: credential.rules, purpose, phase: 'prepared', at: new Date().toISOString() };
  all[id] = value; writeRecords(file, all); return value;
 });
}

export function markPendingVerification(url: string, email: string, employer: string, purpose: CredentialPurpose): boolean {
 return mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingKey(url, email, employer, purpose);
  const value = pendingCredential(url, email, employer, purpose);
  // Requesting a reset email without filling a new password is not a proposal.
  if (!value) return false;
  all[id] = { ...value, phase: 'needs_verification', at: new Date().toISOString() };
  writeRecords(file, all); return true;
 });
}

export function discardPendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose): void {
 mutate(() => {
  const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingKey(url, email, employer, purpose);
  // A later duplicate-registration rejection cannot erase an earlier
  // registration that is known to be awaiting activation.
  if (!all[id] || (purpose === 'create_account' && all[id].phase === 'needs_verification')) return;
  delete all[id]; writeRecords(file, all);
 });
}

type CredentialRecord = Partial<SiteCredential> & { at?: string; status?: 'accepted' | 'rejected' };
function readAll(): Record<string, CredentialRecord> {
  return readRecords<CredentialRecord>(FILE());
}

export function storedCredential(url: string, email: string): SiteCredential | null {
  const record = readAll()[key(url, email)];
  if (!record || (record.status !== undefined && record.status !== 'accepted') || record.format !== 'readable-v1') return null;
  return { format: record.format, ...(record.rules ? { rules: record.rules } : {}) };
}

/** Rejected passwords remain unavailable in subsequent attempts and runs.
 * No password bytes, derived passwords or candidate answers are stored. */
export function rejectCredential(url: string, email: string): void {
 mutate(() => {
  const all = readAll(), id = key(url, email);
  all[id] = { ...all[id], status: 'rejected', at: new Date().toISOString() };
  writeRecords(FILE(), all);
 });
}

function rememberCredential(url: string, email: string, credential: SiteCredential): void {
  const all = readAll();
  all[key(url, email)] = { format: credential.format, ...(credential.rules ? { rules: credential.rules } : {}), status: 'accepted', at: new Date().toISOString() };
  writeRecords(FILE(), all);
}

/** Promote and retire the same proposal under one cross-process lock. Writing
 * acceptance first makes a crash before retirement safe to repeat. A stale
 * worker cannot discard or accept a replacement password proposal. */
export function acceptPendingCredential(url: string, email: string, employer: string, purpose: CredentialPurpose, expected?: SiteCredential): boolean {
  return mutate(() => {
    const file = pendingFile(), all = readRecords<PendingCredential>(file), id = pendingKey(url, email, employer, purpose);
    const credential = pendingCredential(url, email, employer, purpose);
    if (!credential || expected && JSON.stringify([expected.format, expected.rules ?? {}]) !== JSON.stringify([credential.format, credential.rules ?? {}])) return false;
    rememberCredential(url, email, credential);
    delete all[id]; writeRecords(file, all);
    return true;
  });
}
