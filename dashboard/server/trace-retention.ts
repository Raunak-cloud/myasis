import { readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { USERS_DIR } from './userdata.js';

/**
 * Keeps run traces from growing without limit.
 *
 * Every application the agent could not finish leaves a trace: one JSON file
 * per job holding every step it took, with screenshots. They are worth having
 * while a failure is still worth investigating and worthless afterwards, and
 * nobody but an operator ever opens one. Measured on this installation they
 * are 40-48 MB per account and, unlike the browser profiles, nothing was
 * removing them — which made them the fastest-growing thing on the disk.
 *
 * A trace older than a fortnight is deleted. A fortnight because that is
 * comfortably longer than anyone takes to look into a failed run, and short
 * enough that the total stays flat instead of climbing with account age.
 */
const MAX_AGE_DAYS = Math.max(1, Number(process.env.TRACE_RETENTION_DAYS ?? 14));

interface TracePruneResult {
  freedBytes: number;
  removed: number;
  kept: number;
}

/**
 * Deletes one account's expired traces.
 *
 * Age is taken from the file's own timestamp rather than from anything
 * recorded inside it, so a trace written by an older version of the bot is
 * handled the same way. A run in progress is not a reason to wait: traces are
 * written once under a job's own id and never revisited, so an old one can
 * never be the file a live run is writing.
 */
function pruneUserTraces(userId: string, cutoff: number): TracePruneResult {
  const dir = resolve(USERS_DIR, userId, 'traces');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { freedBytes: 0, removed: 0, kept: 0 };
  }

  let freedBytes = 0;
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(dir, entry.name);
    try {
      const { mtimeMs, size } = statSync(path);
      if (mtimeMs >= cutoff) {
        kept += 1;
        continue;
      }
      rmSync(path, { force: true });
      freedBytes += size;
      removed += 1;
    } catch {
      // Vanished or locked; the next sweep will get it.
    }
  }
  return { freedBytes, removed, kept };
}

export function pruneAllTraces(): TracePruneResult {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const total: TracePruneResult = { freedBytes: 0, removed: 0, kept: 0 };
  let accounts: string[];
  try {
    accounts = readdirSync(USERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return total;
  }
  for (const userId of accounts) {
    const result = pruneUserTraces(userId, cutoff);
    total.freedBytes += result.freedBytes;
    total.removed += result.removed;
    total.kept += result.kept;
  }
  return total;
}

/** How long a trace is kept, for the operator's benefit. */
export const TRACE_RETENTION_DAYS = MAX_AGE_DAYS;

let maintenance: NodeJS.Timeout | null = null;

/**
 * Sweeps daily rather than fortnightly.
 *
 * The rule is the age of a trace, not the interval between sweeps: a daily
 * pass means the oldest trace on disk is never more than a day past its
 * fortnight, where a fortnightly pass would let it reach four weeks and make
 * the disk usage swing by the whole amount each time it ran.
 */
export function startTraceRetention(): void {
  if (maintenance) return;
  const sweep = () => {
    try {
      const { freedBytes, removed } = pruneAllTraces();
      if (removed > 0) {
        console.log(`[traces] removed ${removed} trace(s) older than ${MAX_AGE_DAYS} days, freeing ${(freedBytes / 1024 / 1024).toFixed(0)} MB`);
      }
    } catch (error) {
      console.warn('[traces] sweep failed:', (error as Error).message);
    }
  };
  setTimeout(sweep, 7 * 60_000).unref();
  maintenance = setInterval(sweep, 24 * 60 * 60 * 1000);
  maintenance.unref();
}
