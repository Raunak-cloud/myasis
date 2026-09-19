import { createHash } from 'node:crypto';
import { query } from './db/index.js';
import { runner, MAX_CONCURRENT } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, RUN_TIME_ZONE, type Entitlements } from './entitlements.js';
import { sessionFor } from './signin.js';
import { sendDailyDigests, digestDue } from './digest.js';
import { sendAccountAlerts } from './alerts.js';
import { accountSetupComplete } from './setup.js';
import { readSiteState } from './seek-state.js';

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
 * Admin accounts get ten runs a day on the same timetable. Any account can
 * switch its automatic runs off — found a job, taking a break — and a
 * switched-off account is not scheduled at all until it switches them on.
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
  /** The account holder has uploaded a résumé and set details, search terms and location. */
  ready: boolean;
}

async function scheduledAccounts(): Promise<Scheduled[]> {
  /**
   * An account only joins the automatic timetable after onboarding has
   * produced the one thing every live application requires: a resume.
   *
   * Previously every newly-created user was scheduled immediately. The
   * first due tick then called `startRun`, was (correctly) refused for having
   * no resume, and surfaced that refusal as "The last scheduled run could
   * not start". That makes an unfinished setup look like a failed service.
   * Keeping those accounts out of the timetable also prevents them from
   * taking slots away from candidates who are ready to apply.
   */
  const users = await query<{ id: string; email: string }>(
    `SELECT u.id::text AS id, u.email
       FROM users u
      WHERE EXISTS (SELECT 1 FROM resumes r WHERE r.user_id = u.id)
        AND u.blocked_at IS NULL
      ORDER BY u.id`,
  );
  const scheduled: Scheduled[] = [];
  for (const user of users) {
    try {
      const entitlements = await entitlementsFor(user.id, user.email);
      if (entitlements.autoRunsPerDay === 0 || entitlements.autoApplyPaused) continue;
      const ready = (await accountSetupComplete(user.id).catch(() => false)) && boardAvailable(user.id);
      scheduled.push({ userId: user.id, email: user.email, entitlements, ready });
    } catch {
      // One unavailable account must not hide the schedule for everyone else.
    }
  }
  return scheduled;
}

/** Timetabled accounts that are set up, in the stable order their slots are computed from. */
function timetabled(accounts: Scheduled[]): Scheduled[] {
  return accounts.filter((account) => account.ready);
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

export interface AutoScheduleStatus {
  runsUsedToday: number;
  runsPerDay: number;
  /** Null while the account's setup is unfinished: nothing is scheduled until it is. */
  nextRunAt: string | null;
  dueNow: boolean;
  timeZone: string;
  lastError: { message: string; at: string } | null;
  /** The account holder still has setup steps to do before any scheduled run. */
  waitingForSetup: boolean;
}

/** The next slot the same timetable used by `autoRunTick` assigns this account. */
/**
 * A run can only apply through a board the account is signed in to. An
 * account whose every known board session is dead is left off the
 * timetable rather than given a run that fails at the sign-in check and
 * reports a broken service. A board never checked is not held against it:
 * the first run is how that gets found out.
 */
function boardAvailable(userId: string): boolean {
  const states = [readSiteState(userId, 'seek'), readSiteState(userId, 'indeed')];
  const known = states.filter((state) => state !== null);
  return known.length === 0 || known.some((state) => state!.signedIn);
}

export async function autoScheduleFor(userId: string, now: Date = new Date()): Promise<AutoScheduleStatus | null> {
  const accounts = await scheduledAccounts();
  const account = accounts.find((candidate) => candidate.userId === userId);
  if (!account) {
    // Switched off, not set up, or a plan without a schedule: nothing is due, so nothing can have failed.
    // Do not retain an onboarding refusal if the account is not yet eligible
    // for automatic runs. Once a resume is uploaded it starts with a clean
    // schedule instead of showing an obsolete failure.
    lastRefusal.delete(userId);
    return null;
  }

  const runsPerDay = account.entitlements.autoRunsPerDay;
  const runsUsedToday = account.entitlements.autoRunsUsedToday;
  if (!account.ready) {
    return { runsUsedToday, runsPerDay, nextRunAt: null, dueNow: false, timeZone: RUN_TIME_ZONE, lastError: null, waitingForSetup: true };
  }
  const lastError = lastRefusal.get(userId) ?? null;

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
    waitingForSetup: false,
  };
}

/**
 * One pass. Returns the accounts it started, for the log and for tests.
 */
export async function autoRunTick(now: Date = new Date()): Promise<string[]> {
  // The evening summary is independent of when runs happen; it goes out once, after 9pm.
  await sendAccountAlerts(now).catch((error) => console.warn('[alerts] failed:', (error as Error).message));
  if (digestDue(now)) {
    await sendDailyDigests(now).catch((error) => console.warn('[digest] failed:', (error as Error).message));
  }

  const scheduled = await scheduledAccounts();
  if (!scheduled.length) return [];
  const elapsed = minutesIntoDay(now);
  // An account still setting up has nothing to report as a failure.
  for (const account of scheduled) if (!account.ready) lastRefusal.delete(account.userId);

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
      dueAt: dueMinutes(account.userId, today, index, account.entitlements.autoRunsUsedToday, order.length, MAX_CONCURRENT, account.entitlements.autoRunsPerDay),
    }))
    .filter((a) => a.done < a.entitlements.autoRunsPerDay && elapsed >= a.dueAt && free(a.userId))
    .sort((a, b) => a.done - b.done || a.dueAt - b.dueAt);

  const started: string[] = [];
  for (const account of dueTimetabled) {
    if (runner.activeCount() >= MAX_CONCURRENT) break; // lanes full; the rest wait for the next tick
    const { userId, email, entitlements } = account;

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
      console.log(`[autorun] user ${userId}: run ${count} of ${entitlements.autoRunsPerDay}`);
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
    `[autorun] around the clock (${RUN_TIME_ZONE}), times vary daily, ${MAX_CONCURRENT} at a time`,
  );
  tick();
}

export function stopAutoRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
