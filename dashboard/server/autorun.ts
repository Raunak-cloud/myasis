import { createHash } from 'node:crypto';
import { query } from './db/index.js';
import { runner, MAX_CONCURRENT } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, lastRunStartedAt, RUN_TIME_ZONE, type Entitlements } from './entitlements.js';
import { sessionFor } from './signin.js';
import { sendDailyDigests, digestDue } from './digest.js';

/**
 * Applications for the accounts that do not drive runs themselves.
 *
 * A standard account never presses start. It saves what work it wants and
 * this applies for it a few times a day, spread across the whole 24 hours:
 * listings go up at any hour, and an early application is seen first.
 *
 * Every account has its own timetable rather than competing for whoever the
 * next sweep happens to notice. The machine runs a small number of browsers
 * at once, so with everyone eligible at the same moment the naive version
 * was a scramble: two accounts won each tick and the rest were refused, and
 * the same accounts won every time because the sweep read them in the same
 * order. Handing each account fixed times spreads the same work evenly and
 * makes a starved account impossible.
 *
 * Admin accounts have no daily count at all. They run back to back, around
 * the clock, with a short pause between one run ending and the next
 * starting, and they yield the lanes to timetabled accounts whose slot is
 * due.
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

const DAY_MINUTES = 24 * 60;

/**
 * The pause between an admin account's runs.
 *
 * Not a limit on how much it applies: a run that just finished has already
 * reviewed what the boards were showing, and searching again the same minute
 * mostly re-reads the same listings — traffic of exactly the kind that has
 * earned a board's bot challenge before.
 */
const CONTINUOUS_GAP_MS = Math.max(1, Number(process.env.AUTO_RUN_GAP_MINUTES ?? 15)) * 60_000;

/**
 * When an account's Nth run of the day is due, as minutes after local
 * midnight.
 *
 * The day splits into one block per run, and each block splits into a slot
 * per account sharing a lane. Two accounts with the same slot sit in
 * different lanes, so the number starting together never exceeds the number
 * the machine can run.
 *
 * With ten accounts, two lanes and four runs a day: blocks are 360 minutes,
 * five accounts share each lane, so slots are 72 minutes. Account 0 goes at
 * 0:00, 6:00, 12:00 and 18:00; account 2 at 1:12, 7:12 and so on; accounts 0
 * and 1 start together because they are in different lanes.
 */
export function slotMinutes(
  index: number,
  run: number,
  accounts: number,
  lanes: number,
  runsPerDay: number,
  dayMinutes: number = DAY_MINUTES,
): number {
  const block = dayMinutes / Math.max(1, runsPerDay);
  const perLane = Math.max(1, Math.ceil(accounts / Math.max(1, lanes)));
  const slot = block / perLane;
  const position = Math.floor(index / Math.max(1, lanes));
  return run * block + position * slot;
}

/** A stable number in [0, 1) for a key: the same on every tick and restart, unrelated for the next key. */
function unit(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}

/**
 * When an account's Nth run on a given local day is due, in minutes after
 * midnight.
 *
 * Its timetable slot, moved every day: the slot it takes within the block
 * rotates, and the minute within that slot is drawn afresh for each account,
 * date and run. A job board sees an account arrive at a different time each
 * day instead of 6:00, 12:00 and 18:00 on the dot, which is what an
 * automated schedule looks like. Seeded rather than random, so every tick
 * that day — and a restart — agrees on the time. Slots never overlap, so the
 * lane guarantee of `slotMinutes` still holds.
 */
export function dueMinutes(
  userId: string,
  day: string,
  index: number,
  run: number,
  accounts: number,
  lanes: number,
  runsPerDay: number,
): number {
  const block = DAY_MINUTES / Math.max(1, runsPerDay);
  const perLane = Math.max(1, Math.ceil(accounts / Math.max(1, lanes)));
  const slot = block / perLane;
  // One rotation for everyone that day, drawn per date: slots stay disjoint, and the order is not a daily step.
  const rotation = Math.floor(unit(`rotation|${day}`) * perLane);
  const position = (Math.floor(index / Math.max(1, lanes)) + rotation) % perLane;
  return run * block + position * slot + unit(`${userId}|${day}|${run}`) * slot * 0.9;
}

/** The local calendar date, as YYYY-MM-DD. */
export function localDay(at: Date = new Date(), timeZone = RUN_TIME_ZONE): string {
  return at.toLocaleDateString('en-CA', { timeZone });
}

/** Minutes since local midnight. */
export function minutesIntoDay(at: Date = new Date(), timeZone = RUN_TIME_ZONE): number {
  const { hour, minute } = localDateTime(at, timeZone);
  return hour * 60 + minute;
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
      if (entitlements.autoRunsPerDay !== 0) scheduled.push({ userId: user.id, email: user.email, entitlements });
    } catch {
      // One unavailable account must not hide the schedule for everyone else.
    }
  }
  return scheduled;
}

/** Timetabled accounts, in the stable order their slots are computed from. */
function timetabled(accounts: Scheduled[]): Scheduled[] {
  return accounts.filter((account) => account.entitlements.autoRunsPerDay !== null);
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

/**
 * Why the last scheduled run for an account could not start, until one does.
 *
 * Nobody is watching a scheduled run begin, so a refusal — no résumé, no
 * applications left, today's limit — used to reach only the server log, and
 * the account simply saw nothing happen. Kept in memory: the next tick after
 * a restart finds the same reason again.
 */
const lastRefusal = new Map<string, { message: string; at: string }>();
/** When each back-to-back account last tried to start, so a refusal waits the same pause as a finished run. */
const lastAttempt = new Map<string, number>();

export interface AutoScheduleStatus {
  runsUsedToday: number;
  /** Null for an account that runs back to back with no daily count. */
  runsPerDay: number | null;
  nextRunAt: string;
  dueNow: boolean;
  timeZone: string;
  lastError: { message: string; at: string } | null;
}

/**
 * When a back-to-back account is next due: a pause after whichever came last,
 * its run ending or its last try. The pause varies, between 60% and 160% of
 * the configured gap, seeded by that moment so it holds steady until the next
 * run and is different after it.
 */
async function continuousDueAt(userId: string): Promise<number> {
  const state = runner.stateFor(userId);
  const finished = state.finishedAt ? Date.parse(state.finishedAt) : 0;
  const started = (await lastRunStartedAt(userId, 'auto'))?.getTime() ?? 0;
  const last = Math.max(finished, started, lastAttempt.get(userId) ?? 0);
  return last ? last + Math.round(CONTINUOUS_GAP_MS * (0.6 + unit(`${userId}|${last}`))) : 0;
}

/** The next slot the same timetable used by `autoRunTick` assigns this account. */
export async function autoScheduleFor(userId: string, now: Date = new Date()): Promise<AutoScheduleStatus | null> {
  const accounts = await scheduledAccounts();
  const account = accounts.find((candidate) => candidate.userId === userId);
  if (!account) return null;

  const runsPerDay = account.entitlements.autoRunsPerDay;
  const runsUsedToday = account.entitlements.autoRunsUsedToday;
  const lastError = lastRefusal.get(userId) ?? null;

  if (runsPerDay === null) {
    const dueAt = await continuousDueAt(userId);
    const dueNow = dueAt <= now.getTime();
    return {
      runsUsedToday,
      runsPerDay: null,
      nextRunAt: new Date(dueNow ? now.getTime() : dueAt).toISOString(),
      dueNow,
      timeZone: RUN_TIME_ZONE,
      lastError,
    };
  }

  const order = timetabled(accounts);
  const index = order.findIndex((candidate) => candidate.userId === userId);
  const localNow = localDateTime(now);
  const tomorrow = runsUsedToday >= runsPerDay;
  const run = tomorrow ? 0 : runsUsedToday;
  const calendar = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + (tomorrow ? 1 : 0)));
  const minutes = dueMinutes(userId, calendar.toISOString().slice(0, 10), index, run, order.length, MAX_CONCURRENT, runsPerDay);
  const next = zonedInstant({
    year: calendar.getUTCFullYear(),
    month: calendar.getUTCMonth() + 1,
    day: calendar.getUTCDate(),
    hour: Math.floor(minutes / 60),
    minute: Math.round(minutes % 60),
  });
  const dueNow = !tomorrow && next.getTime() <= now.getTime();

  return {
    runsUsedToday,
    runsPerDay,
    nextRunAt: (dueNow ? now : next).toISOString(),
    dueNow,
    timeZone: RUN_TIME_ZONE,
    lastError,
  };
}

/**
 * One pass. Returns the accounts it started, for the log and for tests.
 */
export async function autoRunTick(now: Date = new Date()): Promise<string[]> {
  // The evening summary is independent of when runs happen; it goes out once, after 9pm.
  if (digestDue(now)) {
    await sendDailyDigests(now).catch((error) => console.warn('[digest] failed:', (error as Error).message));
  }

  const scheduled = await scheduledAccounts();
  if (!scheduled.length) return [];
  const elapsed = minutesIntoDay(now);

  /**
   * The timetable is built from the accounts the scheduler serves, in a
   * stable order, so an account keeps the same times all day. Adding an
   * account reshuffles positions, which only moves the remaining slots a
   * little — the count each account has already had is what decides which
   * slot is next, so nobody loses a run to the reshuffle.
   */
  const order = timetabled(scheduled);
  const today = localDay(now);
  const free = (userId: string) => !runner.stateFor(userId).running && !sessionFor(userId);

  /**
   * Timetabled accounts whose slot has passed, hungriest first.
   *
   * Taking them in account order instead looked fine until a day of slow
   * runs was played out: the lanes were always busy by the time the list
   * reached the last accounts, so the first six got all five runs and the
   * last two got none. Ordering by how far behind an account is means a
   * shortage is shared — everyone loses their fifth run before anyone loses
   * their first.
   */
  const dueTimetabled = order
    .map((account, index) => ({
      ...account,
      done: account.entitlements.autoRunsUsedToday,
      dueAt: dueMinutes(account.userId, today, index, account.entitlements.autoRunsUsedToday, order.length, MAX_CONCURRENT, account.entitlements.autoRunsPerDay ?? 1),
    }))
    .filter((a) => a.done < (a.entitlements.autoRunsPerDay ?? 0) && elapsed >= a.dueAt && free(a.userId))
    .sort((a, b) => a.done - b.done || a.dueAt - b.dueAt);

  // Back-to-back accounts take whatever lanes the timetable leaves, longest waiting first.
  const continuous: Array<Scheduled & { dueAt: number }> = [];
  for (const account of scheduled) {
    if (account.entitlements.autoRunsPerDay !== null || !free(account.userId)) continue;
    const dueAt = await continuousDueAt(account.userId);
    if (dueAt <= now.getTime()) continuous.push({ ...account, dueAt });
  }
  continuous.sort((a, b) => a.dueAt - b.dueAt);

  const started: string[] = [];
  for (const account of [...dueTimetabled, ...continuous]) {
    if (runner.activeCount() >= MAX_CONCURRENT) break; // lanes full; the rest wait for the next tick
    const { userId, email, entitlements } = account;
    if (entitlements.autoRunsPerDay === null) lastAttempt.set(userId, now.getTime());

    /**
     * A live run, like every run: nobody is watching a scheduled one. Every
     * allowance check and deduction still applies — `startRun` is the path
     * the manual button uses.
     */
    const result = await startRun({ userId, email, mode: 'live', trigger: 'auto' });
    if (result.ok) {
      started.push(userId);
      lastRefusal.delete(userId);
      const count = entitlements.autoRunsUsedToday + 1;
      console.log(
        `[autorun] user ${userId}: ${entitlements.autoRunsPerDay === null ? `run ${count} today` : `run ${count} of ${entitlements.autoRunsPerDay}`}`,
      );
    } else {
      // 409 is "busy right now" — a lane, a sign-in, a run already going — and rights itself next tick.
      if (result.status !== 409) lastRefusal.set(userId, { message: result.error, at: now.toISOString() });
      if (![402, 409, 428, 429].includes(result.status)) {
        console.warn(`[autorun] user ${userId}: ${result.error}`);
      }
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
    `[autorun] around the clock (${RUN_TIME_ZONE}), times vary daily, ${MAX_CONCURRENT} at a time, ~${CONTINUOUS_GAP_MS / 60_000} min (varied) between admin runs`,
  );
  tick();
}

export function stopAutoRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
