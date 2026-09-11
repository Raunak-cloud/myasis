import { query } from './db/index.js';
import { runner } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, lastRunStartedAt, AUTO_WINDOW, RUN_TIME_ZONE } from './entitlements.js';

/**
 * Applications for the accounts that do not drive runs themselves.
 *
 * A standard account never presses start. It saves what work it wants and
 * this fires a live run for it a few times across the day, inside waking
 * hours, from those saved preferences.
 *
 * Deliberately an interval in this process rather than a job queue. The whole
 * workload is a handful of runs per account per day on a single-instance
 * server, and the durable state a queue would give us is already in
 * `run_starts` — the scheduler holds nothing in memory that matters, so a
 * restart resumes correctly by reading the database. If this ever runs on
 * more than one instance the ticks would need a lock (an advisory lock, or
 * pg-boss); that is the line at which this design stops being the right one.
 */

/** How often to look. Fine-grained enough to hit a spacing window, cheap enough to ignore. */
const TICK_MS = 5 * 60_000;

/**
 * Runs are spread across the day rather than fired the moment the window
 * opens: five applications arriving at 9:01 looks like a script, and a
 * candidate who tops up mid-morning would find the day already spent.
 */
function minimumGapMs(runsPerDay: number): number {
  const windowMs = (AUTO_WINDOW.endHour - AUTO_WINDOW.startHour) * 3_600_000;
  return Math.floor(windowMs / Math.max(1, runsPerDay));
}

/** The hour of the local day, wherever the server itself happens to think it is. */
export function localHour(at: Date = new Date(), timeZone = RUN_TIME_ZONE): number {
  const hour = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone }).format(at);
  return Number(hour);
}

export function insideWindow(at: Date = new Date()): boolean {
  const hour = localHour(at);
  return hour >= AUTO_WINDOW.startHour && hour < AUTO_WINDOW.endHour;
}

interface UserRow {
  id: string;
  email: string;
}

/**
 * One pass over every account. Returns what it started, for the log and for
 * tests — nothing here depends on the return value.
 */
export async function autoRunTick(now: Date = new Date()): Promise<string[]> {
  if (!insideWindow(now)) return [];

  const users = await query<UserRow>('SELECT id::text AS id, email FROM users ORDER BY id');
  const started: string[] = [];

  for (const user of users) {
    // Whatever else is true, never queue behind this account's own run.
    if (runner.stateFor(user.id).running) continue;

    let entitlements;
    try {
      entitlements = await entitlementsFor(user.id, user.email);
    } catch {
      continue; // A billing lookup that fails is not a reason to stop the sweep.
    }
    if (entitlements.autoRunsPerDay < 1) continue;
    if (entitlements.autoRunsUsedToday >= entitlements.autoRunsPerDay) continue;

    const last = await lastRunStartedAt(user.id, 'auto').catch(() => null);
    if (last && now.getTime() - last.getTime() < minimumGapMs(entitlements.autoRunsPerDay)) continue;

    /**
     * A live run, because that is the whole point of the tier: nobody is
     * watching to promote a rehearsal into an application. Every allowance
     * check and deduction still applies — `startRun` is the same path the
     * manual button uses.
     */
    const result = await startRun({
      userId: user.id,
      email: user.email,
      mode: 'live',
      trigger: 'auto',
    });

    if (result.ok) {
      started.push(user.id);
      console.log(`[autorun] started a live run for user ${user.id}`);
    } else if (result.status !== 409 && result.status !== 402) {
      // 409 is "already running or at capacity" and 402 is "out of
      // allowance"; both are ordinary and will right themselves.
      console.warn(`[autorun] user ${user.id}: ${result.error}`);
    }
  }

  return started;
}

let timer: NodeJS.Timeout | null = null;

export function startAutoRunner(): void {
  if (timer) return;
  const tick = () => {
    void autoRunTick().catch((error) => console.warn('[autorun] tick failed:', (error as Error).message));
  };
  timer = setInterval(tick, TICK_MS);
  // Node keeps the process alive for timers; this one must not be the reason it stays up.
  timer.unref?.();
  console.log(
    `[autorun] scheduling automatic runs ${AUTO_WINDOW.startHour}:00-${AUTO_WINDOW.endHour}:00 ${RUN_TIME_ZONE}`,
  );
  tick();
}

export function stopAutoRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
