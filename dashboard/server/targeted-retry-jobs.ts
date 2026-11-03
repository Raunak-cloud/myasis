import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { jobBoardForUrl } from '../../seek-bot/src/job-board-url.js';
import { traceProvesNoSend } from '../../seek-bot/src/repair-safety.js';
import { query } from './db/index.js';
import { readRunAttempt } from './run-diagnostics.js';
import { userDir } from './userdata.js';

export interface TargetedSeekJob { job_id: string; title: string; company: string }
interface SourceRun { id: string; user_id: string; finished_at: Date | string | null }
interface Dependencies { query: typeof query; directory: typeof userDir }
const defaults: Dependencies = { query, directory: userDir };
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
// Leave room for complete retained screenshots without allowing an unbounded
// synchronous read in an API request.
export const TARGET_RETRY_TRACE_MAX_BYTES = 32 * 1024 * 1024;

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid retry evidence.');
  return value as Record<string, any>;
}
function canonicalOwner(directory: string): string {
  const owner = resolve(directory), actual = realpathSync(owner);
  // This also rejects a symlink in any parent, rather than just the final file.
  if (owner !== actual || !lstatSync(owner).isDirectory()) throw Error('Invalid retry owner directory.');
  return owner;
}
function readEvidence(owner: string, name: string): { value: Record<string, any>; hash: string } {
  const file = resolve(owner, 'traces', name), actual = realpathSync(file), part = relative(owner, actual);
  if (actual !== file || !part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw Error('Invalid retry evidence path.');
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > TARGET_RETRY_TRACE_MAX_BYTES) throw Error('Invalid retry evidence file.');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > TARGET_RETRY_TRACE_MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) throw Error('Retry evidence changed.');
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(file);
    if (bytes.length > TARGET_RETRY_TRACE_MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino
      || realpathSync(file) !== file) throw Error('Retry evidence changed.');
    return { value: record(JSON.parse(bytes.toString('utf8'))), hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}
function liveEvidence(owner: string, id: string): ReturnType<typeof readEvidence> | undefined {
  try { lstatSync(resolve(owner, 'traces', `${id}.live.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return readEvidence(owner, `${id}.live.json`);
}
function boundJob(trace: Record<string, any>, id: string): TargetedSeekJob {
  const job = record(trace.job);
  if (trace.jobId !== id || job.id !== id || job.platform !== 'seek' || typeof job.url !== 'string'
    || typeof job.title !== 'string' || !job.title.trim() || typeof job.company !== 'string' || !job.company.trim()
    || trace.title !== job.title || trace.company !== job.company) throw Error('Retry job identity does not match.');
  const url = new URL(job.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || jobBoardForUrl(url.href) !== 'seek'
    || !new RegExp(`^/job/${id}/?$`).test(url.pathname)) throw Error('Retry listing is not the exact SEEK job.');
  return { job_id: id, title: job.title, company: job.company };
}

/** Resolve metadata, never authorization or a historical fit decision. Only a
 * latest terminal attempt with its own verified run and no-send proof can fill
 * a missing event row. The normal run refetches and reassesses the listing. */
export async function targetedSeekRetryJobs(userId: string, ids: string[], deps: Dependencies = defaults): Promise<TargetedSeekJob[] | null> {
  if (!/^\d{1,19}$/.test(userId) || !ids.length || ids.some(id => !/^\d{6,12}$/.test(id))) return null;
  const jobs = await deps.query<TargetedSeekJob>(
    `SELECT DISTINCT ON (job_id) job_id, title, company FROM run_events
     WHERE user_id=$1 AND job_id=ANY($2::text[]) AND title<>'' AND company<>'' ORDER BY job_id, ts DESC`, [userId, ids]);
  const found = new Map(jobs.filter(job => ids.includes(job.job_id) && job.title?.trim() && job.company?.trim()).map(job => [job.job_id, job]));
  if (found.size === ids.length) return ids.map(id => found.get(id)!);
  try {
    const owner = canonicalOwner(deps.directory(userId));
    for (const id of ids.filter(id => !found.has(id))) {
      const pointer = readEvidence(owner, `${id}.json`), trace = pointer.value;
      const metadata = boundJob(trace, id), runId = String(trace.runStartId), attemptId = trace.attemptId;
      if (!/^\d{1,19}$/.test(runId) || typeof attemptId !== 'string' || !uuid.test(attemptId)
        || !traceProvesNoSend(trace, runId, attemptId)) return null;
      const [run] = await deps.query<SourceRun>(
        'SELECT id::text,user_id::text,finished_at FROM run_starts WHERE user_id=$1 AND id=$2 AND finished_at IS NOT NULL', [userId, runId]);
      if (!run || run.user_id !== userId || run.id !== runId || !run.finished_at || !Number.isFinite(new Date(run.finished_at).getTime())) return null;
      const latestLive = liveEvidence(owner, id);
      if (latestLive && (latestLive.value.attemptId !== attemptId || String(latestLive.value.runStartId) !== runId)) return null;
      if (latestLive) boundJob(latestLive.value, id);
      const immutable = readEvidence(owner, `attempt-${attemptId}.json`);
      const attempt = record(readRunAttempt(runId, owner, attemptId));
      if (JSON.stringify(attempt) !== JSON.stringify(immutable.value) || immutable.hash !== pointer.hash
        || !traceProvesNoSend(attempt, runId, attemptId)) return null;
      boundJob(attempt, id);
      // Atomic trace writers may replace an alias while an awaited DB read is
      // pending. Never authorize metadata from the superseded safe attempt.
      if (readEvidence(owner, `${id}.json`).hash !== pointer.hash) return null;
      const currentLive = liveEvidence(owner, id);
      if (currentLive?.hash !== latestLive?.hash) return null;
      found.set(id, metadata);
    }
    return ids.map(id => found.get(id)!);
  } catch { return null; }
}
