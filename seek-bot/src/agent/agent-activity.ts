import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import type { JobListing } from '../types.js';

type ActivityState = { status: 'running' | 'finished' | 'interrupted'; submitted?: boolean; outcome?: string; detail?: string };
type Activity = ActivityState & {
  id: string; jobId: string; title: string; company: string; platform: string; url: string;
  startedAt: string; updatedAt: string; stale?: boolean;
};
type StoredActivity = { record: Activity; file: string };
const FOLDER = 'agent-activity';
const FINISHED_TO_KEEP = 500;
const MAX_RECORDS_READ = 2000;
const ACTIVITY_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
let warned = false;

function warn(): void {
  if (warned) return;
  warned = true;
  console.warn('Advisory application activity history is unavailable; the agent continues without it.');
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return Boolean(path) && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function directory(ownerDirectory: string, create: boolean): string | null {
  try {
    if (create) mkdirSync(ownerDirectory, { recursive: true });
    const owner = realpathSync(ownerDirectory), requested = resolve(owner, FOLDER);
    if (!existsSync(requested)) {
      if (!create) return null;
      try { mkdirSync(requested, { mode: 0o700 }); }
      catch (error) { if (!existsSync(requested)) throw error; }
    }
    const stat = lstatSync(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe activity directory');
    const actual = realpathSync(requested);
    if (!inside(owner, actual)) throw new Error('Activity directory outside owner');
    return actual;
  } catch { if (create) warn(); return null; }
}

function readRecords(folder: string): StoredActivity[] {
  const entries: StoredActivity[] = [];
  for (const name of readdirSync(folder)) {
    if (!ACTIVITY_FILE.test(name)) continue;
    const file = resolve(folder, name);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_000 || !inside(folder, realpathSync(file))) continue;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Activity>;
      if (raw.id !== name.slice(0, -5) || !['running', 'finished', 'interrupted'].includes(raw.status ?? '')
        || typeof raw.jobId !== 'string' || typeof raw.startedAt !== 'string' || typeof raw.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(raw.startedAt)) || !Number.isFinite(Date.parse(raw.updatedAt))) continue;
      // Copy only advisory fields; activity files cannot inject environment,
      // credentials, private filesystem paths or extra control instructions.
      const record: Activity = {
        id: raw.id, jobId: raw.jobId, title: String(raw.title ?? ''), company: String(raw.company ?? ''),
        platform: String(raw.platform ?? ''), url: String(raw.url ?? ''), status: raw.status!,
        startedAt: raw.startedAt, updatedAt: raw.updatedAt,
        ...(typeof raw.submitted === 'boolean' ? { submitted: raw.submitted } : {}),
        ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
        ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      };
      entries.push({ record, file });
    } catch { /* A concurrent rename, partial legacy record or removed file is not a blocker. */ }
  }
  return entries.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt) || a.record.id.localeCompare(b.record.id));
}

function trimFinished(folder: string): void {
  try {
    for (const item of readRecords(folder).filter(item => item.record.status !== 'running').slice(FINISHED_TO_KEEP)) {
      try { unlinkSync(item.file); } catch { /* Another worker may already have removed the old record. */ }
    }
  } catch { warn(); }
}

/** Observability only: starting two attempts at the same job is allowed.
 * This never reads/writes claims, locks, application indices or allowances. */
export function startAgentActivity(job: JobListing): { update(state: ActivityState): void; close(): void } {
  // Capture account identity once; a later nested environment cannot redirect
  // this attempt's updates into another account's directory.
  const owner = config.dataDir;
  let folder = directory(owner, true), file = '', closed = false;
  let record: Activity = {
    id: randomUUID(), jobId: job.id, title: job.title, company: job.company, platform: job.platform ?? 'seek', url: job.url,
    status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (folder) {
    try {
      // Exclusive creation proves ownership of this UUID before replacement.
      // The empty initial file is ignored by readers until atomic rename.
      for (let attempt = 0; attempt < 3; attempt++) {
        file = resolve(folder, `${record.id}.json`);
        try { closeSync(openSync(file, 'wx', 0o600)); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          record = { ...record, id: randomUUID() }; file = '';
        }
      }
      if (!file) throw new Error('Could not allocate activity id');
    } catch { warn(); folder = null; }
  }
  const write = () => {
    if (!folder) return;
    let temporary = '';
    try {
      if (directory(owner, false) !== folder) throw new Error('Activity directory changed');
      if (lstatSync(file).isSymbolicLink() || !inside(folder, realpathSync(file))) throw new Error('Activity file changed');
      temporary = resolve(folder, `${record.id}.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      if (record.status !== 'running') trimFinished(folder);
    } catch { warn(); }
    finally { if (temporary) { try { unlinkSync(temporary); } catch { /* Renamed already or unavailable. */ } } }
  };
  const update = (state: ActivityState) => {
    if (closed) return;
    record = { ...record, status: state.status, updatedAt: new Date().toISOString(),
      ...(typeof state.submitted === 'boolean' ? { submitted: state.submitted } : {}),
      ...(typeof state.outcome === 'string' ? { outcome: state.outcome.slice(0, 500) } : {}),
      ...(typeof state.detail === 'string' ? { detail: state.detail.slice(0, 2000) } : {}),
    };
    write();
  };
  write();
  return { update, close: () => {
    if (closed) return;
    if (record.status === 'running') update({ status: 'interrupted', detail: record.detail || 'The agent attempt ended without a final outcome.' });
    closed = true;
  } };
}

/** Recent advisory observations, never an authorization decision. Submitted
 * means the agent marked a send attempt, not independent receipt evidence.
 * Stale running records are labelled for readers without modifying the file. */
export function readAgentActivities(): unknown[] {
  const folder = directory(config.dataDir, false);
  if (!folder) return [];
  try {
    const max = config.celeris.maxTotalMs;
    const staleAfter = (Number.isFinite(max) ? Math.max(0, max) : max === Infinity ? Infinity : 1_800_000) + 300_000;
    return readRecords(folder).slice(0, MAX_RECORDS_READ).map(({ record }) => record.status === 'running' && Date.now() - Date.parse(record.startedAt) > staleAfter
      ? { ...record, status: 'interrupted', stale: true, detail: `The running activity exceeded the application time allowance. ${record.detail ?? ''}`.trim() }
      : record);
  } catch { warn(); return []; }
}
