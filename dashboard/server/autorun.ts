import { query } from './db/index.js';
import { runner, MAX_CONCURRENT } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, AUTO_WINDOW, RUN_TIME_ZONE, type Entitlements } from './entitlements.js';

/**
 * Applications for the accounts that do not drive runs themselves.
 *
 * A standard account never presses start. It saves what work it wants and
 * this applies for it a few times across the day, inside waking hours.
 *
 * Every account has its own timetable rather than competing for whoever the
 * next sweep happens to notice. The machine runs a small number of browsers
 * at once, so with everyone eligible from 9am the naive version was a
 * scramble: two accounts won each tick and the rest were refused, and the
 * same accounts won every time because the sweep read them in the same
 * order. Handing each account fixed times spreads the same work evenly and
 * makes a starved account impossible.
 *
 * Deliberately an interval in this process rather than a job queue. The
 * durable state a queue would give us is already in `run_starts`, which is
 * also what the timetable reads — so a restart resumes mid-day correctly
 * instead of re-firing. If this ever runs on more than one instance the
 * ticks need a lock; that is the line at which this design stops being the
 * right one.
 */

/** How often to look. Fine enough to hit a slot, cheap enough to ignore. */
const TICK_MS = 60_000;

const WINDOW_MINUTES = (AUTO_WINDOW.endHour - AUTO_WINDOW.startHour) * 60;

/**
 * When an account's Nth run of the day is due, as minutes after the window
 * opens.
 *
 * The day splits into one block per run, and each block splits into a slot
 * per account sharing a lane. Two accounts with the same slot sit in
 * different lanes, so the number starting together never exceeds the number
 * the machine can run.
 *
 * With ten accounts, two lanes and five runs across 9am-9pm: blocks are 144
 * minutes, five accounts share each lane, so slots are 28.8 minutes. Account
 * 0 goes at 9:00, 11:24, 13:48, 16:12, 18:36; account 2 at 9:28, 11:52, and
 * so on; accounts 0 and 1 start together because they are in different lanes.
 */
export function slotMinutes(
  index: number,
  run: number,
  accounts: number,
  lanes: number,
  runsPerDay: number,
  windowMinutes: number = WINDOW_MINUTES,
): number {
  const block = windowMinutes / Math.max(1, runsPerDay);
  const perLane = Math.max(1, Math.ceil(accounts / Math.max(1, lanes)));
  const slot = block / perLane;
  const position = Math.floor(index / Math.max(1, lanes));
  return run * block + position * slot;
}

/** Minutes since the window opened, or null when it is shut. */
export function minutesIntoWindow(at: Date = new Date(), timeZone = RUN_TIME_ZONE): number | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZone,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  if (hour < AUTO_WINDOW.startHour || hour >= AUTO_WINDOW.endHour) return null;
  return (hour - AUTO_WINDOW.startHour) * 60 + minute;
}

export function insideWindow(at: Date = new Date()): boolean {
  return minutesIntoWindow(at) !== null;
}

interface Scheduled {
  userId: string;
  email: string;
  entitlements: Entitlements;
}

/**
 * One pass. Returns the accounts it started, for the log and for tests.
 */
export async function autoRunTick(now: Date = new Date()): Promise<string[]> {
  const elapsed = minutesIntoWindow(now);
  if (elapsed === null) return [];

  const users = await query<{ id: string; email: string }>('SELECT id::text AS id, email FROM users ORDER BY id');

  /**
   * The timetable is built from the accounts the scheduler serves, in a
   * stable order, so an account keeps the same times all day. Adding an
   * account reshuffles positions, which only moves the remaining slots a
   * little — the count each account has already had is what decides which
   * slot is next, so nobody loses a run to the reshuffle.
   */
  const scheduled: Scheduled[] = [];
  for (const user of users) {
    try {
      const entitlements = await entitlementsFor(user.id, user.email);
      if (entitlements.autoRunsPerDay > 0) scheduled.push({ userId: user.id, email: user.email, entitlements });
    } catch {
      // A billing lookup that fails is not a reason to abandon the sweep.
    }
  }
  if (!scheduled.length) return [];

  /**
   * Everyone whose slot has passed, hungriest first.
   *
   * Taking them in account order instead looked fine until a day of slow
   * runs was played out: the lanes were always busy by the time the list
   * reached the last accounts, so the first six got all five runs and the
   * last two got none. Ordering by how far behind an account is means a
   * shortage is shared — everyone loses their fifth run before anyone loses
   * their first.
   */
  const due = scheduled
    .map((account, index) => ({
      ...account,
      done: account.entitlements.autoRunsUsedToday,
      dueAt: slotMinutes(index, account.entitlements.autoRunsUsedToday, scheduled.length, MAX_CONCURRENT, account.entitlements.autoRunsPerDay),
    }))
    .filter((a) => a.done < a.entitlements.autoRunsPerDay && elapsed >= a.dueAt && !runner.stateFor(a.userId).running)
    .sort((a, b) => a.done - b.done || a.dueAt - b.dueAt);

  const started: string[] = [];
  for (const account of due) {
    if (runner.activeCount() >= MAX_CONCURRENT) break; // lanes full; the rest wait for the next tick
    const { userId, email, entitlements, done } = account;

    /**
     * A live run, because that is the point of the tier: nobody is watching
     * to promote a rehearsal into an application. Every allowance check and
     * deduction still applies — `startRun` is the path the manual button uses.
     */
    const result = await startRun({ userId, email, mode: 'live', trigger: 'auto' });
    if (result.ok) {
      started.push(userId);
      console.log(`[autorun] user ${userId}: run ${done + 1} of ${entitlements.autoRunsPerDay}`);
    } else if (result.status !== 409 && result.status !== 402) {
      // 409 is "already running or at capacity" and 402 "out of allowance";
      // both are ordinary and right themselves.
      console.warn(`[autorun] user ${userId}: ${result.error}`);
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
  // Node keeps a process alive for timers; this one must not be the reason it stays up.
  timer.unref?.();
  console.log(
    `[autorun] ${AUTO_WINDOW.startHour}:00-${AUTO_WINDOW.endHour}:00 ${RUN_TIME_ZONE}, ${MAX_CONCURRENT} at a time`,
  );
  tick();
}

export function stopAutoRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
