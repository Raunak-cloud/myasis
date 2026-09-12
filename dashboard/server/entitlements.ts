import { query } from './db/index.js';
import { billingStatus, isAdmin } from './billing.js';
import { KEEP_SETTINGS_KEYS } from './settings.js';

/**
 * What an account is allowed to do — decided in one place, for every caller.
 *
 * Two shapes of product live in this app. An operator or an Intensive Pass
 * holder drives runs themselves: they choose rehearse or live, and they tune
 * how a run searches. Everyone else does not drive anything — their
 * applications go out on a schedule, from the preferences they saved, and the
 * knobs that decide how a run behaves are not theirs to set.
 *
 * Every gate in the app reads this module rather than re-deriving the rule
 * from `isAdmin` and a pass flag, because the same rule is enforced in five
 * places (starting a run, the daily cap, saving settings, the rewriting tool,
 * the scheduler) and five copies would drift.
 */

export type Tier = 'admin' | 'intensive' | 'standard';

/** Local time is what a candidate means by "today" and by "9 to 9". */
export const RUN_TIME_ZONE = process.env.RUN_TIME_ZONE?.trim() || 'Australia/Sydney';

/** Hours of the local day inside which automatic runs may start. */
export const AUTO_WINDOW = { startHour: 9, endHour: 21 } as const;

/** Manual runs an Intensive Pass may start per local day. Admins have no cap. */
export const INTENSIVE_MANUAL_RUNS_PER_DAY = 3;

/**
 * Automatic runs a standard account gets per local day.
 *
 * Four rather than five so each run has room to finish inside its slot: two
 * lanes across a twelve-hour window is 1,440 lane-minutes, which ten accounts
 * at four runs each divide into 36 minutes apiece. At five it was 29, close
 * enough to a real run's length that a slow day started costing accounts
 * their last run. More accounts should buy more lanes, not thinner slots.
 */
export const STANDARD_AUTO_RUNS_PER_DAY = 4;

/**
 * The preferences a standard account may edit: who they are, what work they
 * want, and where and for how much. Everything else in `KEEP_SETTINGS_KEYS`
 * — match threshold, listing age, page depth, per-run and per-day ceilings,
 * cover-letter mode, standing instructions — decides how a run *behaves*, and
 * belongs to the tiers that drive runs themselves.
 */
export const BASIC_SETTINGS_KEYS = [
  'KEYWORDS',
  'TARGET_ROLE',
  'WORK_ARRANGEMENTS',
  'ONSITE_CITY',
  'MIN_SALARY',
  'MIN_HOURLY_RATE',
] as const;

/** Plain strings: callers test keys arriving from a request against this. */
export const FINE_TUNING_KEYS: string[] = KEEP_SETTINGS_KEYS.filter(
  (key) => !(BASIC_SETTINGS_KEYS as readonly string[]).includes(key),
);

export interface Entitlements {
  tier: Tier;
  /** May start a rehearsal or a live run by hand. */
  manualRuns: boolean;
  /** Manual runs allowed per local day; null means no cap. */
  manualRunsPerDay: number | null;
  manualRunsUsedToday: number;
  manualRunsLeftToday: number | null;
  /** Automatic runs per local day; 0 for the tiers that drive runs themselves. */
  autoRunsPerDay: number;
  autoRunsUsedToday: number;
  /** May edit the settings that change how a run behaves. */
  fineTune: boolean;
  /** May use the rewriting tool. */
  rewriteText: boolean;
  window: { startHour: number; endHour: number; timeZone: string };
}

function tierFor(admin: boolean, intensive: boolean): Tier {
  if (admin) return 'admin';
  return intensive ? 'intensive' : 'standard';
}

/**
 * Runs this account has started since local midnight.
 *
 * The comparison is written as a round trip through the local zone —
 * truncate in local time, then read the result back as an instant — so the
 * day boundary is the candidate's midnight rather than the database
 * server's, whatever the database is configured to think local means.
 */
export async function runsStartedToday(userId: string, trigger: 'manual' | 'auto'): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM run_starts
      WHERE user_id = $1
        AND trigger = $2
        AND started_at >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3)`,
    [userId, trigger, RUN_TIME_ZONE],
  );
  return Number(rows[0]?.n ?? 0);
}

/** When this account last started a run of the given kind, or null. */
export async function lastRunStartedAt(userId: string, trigger: 'manual' | 'auto'): Promise<Date | null> {
  const rows = await query<{ started_at: Date }>(
    `SELECT started_at FROM run_starts
      WHERE user_id = $1 AND trigger = $2
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId, trigger],
  );
  return rows[0]?.started_at ? new Date(rows[0].started_at) : null;
}

/**
 * One started run. Written once the child is actually spawned — see
 * start-run.ts, which explains why a refused start must not spend a slot
 * while a run that starts and then dies must.
 */
export async function recordRunStart(
  userId: string,
  mode: string,
  trigger: 'manual' | 'auto',
): Promise<void> {
  await query(
    `INSERT INTO run_starts (user_id, mode, trigger) VALUES ($1, $2, $3)`,
    [userId, mode, trigger],
  );
}

export async function entitlementsFor(userId: string, email?: string | null): Promise<Entitlements> {
  const admin = isAdmin(email);
  const billing = await billingStatus(userId, email);
  const intensive = billing.paid.hasActiveIntensivePass;
  const tier = tierFor(admin, intensive);

  const manualRuns = tier !== 'standard';
  const manualRunsPerDay = tier === 'admin' ? null : tier === 'intensive' ? INTENSIVE_MANUAL_RUNS_PER_DAY : 0;
  const autoRunsPerDay = manualRuns ? 0 : STANDARD_AUTO_RUNS_PER_DAY;

  const [manualRunsUsedToday, autoRunsUsedToday] = await Promise.all([
    manualRuns ? runsStartedToday(userId, 'manual') : Promise.resolve(0),
    autoRunsPerDay ? runsStartedToday(userId, 'auto') : Promise.resolve(0),
  ]);

  return {
    tier,
    manualRuns,
    manualRunsPerDay,
    manualRunsUsedToday,
    manualRunsLeftToday: manualRunsPerDay === null ? null : Math.max(0, manualRunsPerDay - manualRunsUsedToday),
    autoRunsPerDay,
    autoRunsUsedToday,
    fineTune: tier !== 'standard',
    rewriteText: tier === 'admin',
    window: { ...AUTO_WINDOW, timeZone: RUN_TIME_ZONE },
  };
}
