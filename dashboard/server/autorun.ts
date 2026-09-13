import { query } from './db/index.js';
import { runner, MAX_CONCURRENT } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, AUTO_WINDOW, RUN_TIME_ZONE, type Entitlements } from './entitlements.js';
import { sendDailyDigests, digestDue } from './digest.js';

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
 * With ten accounts, two lanes and four runs across 9am-9pm: blocks are 180
 * minutes, five accounts share each lane, so slots are 36 minutes. Account 0
 * goes at 9:00, 12:00, 15:00 and 18:00; account 2 at 9:36, 12:36 and so on;
 * accounts 0 and 1 start together because they are in different lanes.
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

async function scheduledAccounts(): Promise<Scheduled[]> {
  const users = await query<{ id: string; email: string }>('SELECT id::text AS id, email FROM users ORDER BY id');
  const scheduled: Scheduled[] = [];
  for (const user of users) {
    try {
      const entitlements = await entitlementsFor(user.id, user.email);
      if (entitlements.autoRunsPerDay > 0) scheduled.push({ userId: user.id, email: user.email, entitlements });
    } catch {
      // One unavailable account must not hide the schedule for everyone else.
    }
  }
  return scheduled;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localDateTime(at: Date, timeZone = RUN_TIME_ZONE): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

/** Convert a wall-clock time in the configured zone into an absolute instant. */
function zonedInstant(local: LocalDateTime, timeZone = RUN_TIME_ZONE): Date {
  const target = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let instant = target;
  // Two passes handle offsets on either side of a daylight-saving transition.
  for (let pass = 0; pass < 2; pass++) {
    const represented = localDateTime(new Date(instant), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
    );
    instant += target - representedUtc;
  }
  return new Date(instant);
}

export interface AutoScheduleStatus {
  runsUsedToday: number;
  runsPerDay: number;
  nextRunAt: string;
  dueNow: boolean;
  timeZone: string;
}

/** The next slot the same timetable used by `autoRunTick` assigns this account. */
export async function autoScheduleFor(userId: string, now: Date = new Date()): Promise<AutoScheduleStatus | null> {
  const accounts = await scheduledAccounts();
  const index = accounts.findIndex((account) => account.userId === userId);
  if (index < 0) return null;

  const account = accounts[index];
  const runsPerDay = account.entitlements.autoRunsPerDay;
  const runsUsedToday = account.entitlements.autoRunsUsedToday;
  const localNow = localDateTime(now);
  const afterWindow = localNow.hour >= AUTO_WINDOW.endHour;
  const tomorrow = afterWindow || runsUsedToday >= runsPerDay;
  const run = tomorrow ? 0 : runsUsedToday;
  const minutes = slotMinutes(index, run, accounts.length, MAX_CONCURRENT, runsPerDay);
  const calendar = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + (tomorrow ? 1 : 0)));
  const next = zonedInstant({
    year: calendar.getUTCFullYear(),
    month: calendar.getUTCMonth() + 1,
    day: calendar.getUTCDate(),
    hour: AUTO_WINDOW.startHour + Math.floor(minutes / 60),
    minute: Math.round(minutes % 60),
  });
  const dueNow = !tomorrow && next.getTime() <= now.getTime();

  return {
    runsUsedToday,
    runsPerDay,
    nextRunAt: (dueNow ? now : next).toISOString(),
    dueNow,
    timeZone: RUN_TIME_ZONE,
  };
}

/**
 * One pass. Returns the accounts it started, for the log and for tests.
 */
export async function autoRunTick(now: Date = new Date()): Promise<string[]> {
  /**
   * Checked before the window, deliberately: the summary goes out once the
   * day's runs are done, which is the moment the window shuts. Putting it
   * after the early return below would mean it never ran at all.
   */
  if (digestDue(now)) {
    await sendDailyDigests(now).catch((error) => console.warn('[digest] failed:', (error as Error).message));
  }

  const elapsed = minutesIntoWindow(now);
  if (elapsed === null) return [];

  /**
   * The timetable is built from the accounts the scheduler serves, in a
   * stable order, so an account keeps the same times all day. Adding an
   * account reshuffles positions, which only moves the remaining slots a
   * little — the count each account has already had is what decides which
   * slot is next, so nobody loses a run to the reshuffle.
   */
  const scheduled = await scheduledAccounts();
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
