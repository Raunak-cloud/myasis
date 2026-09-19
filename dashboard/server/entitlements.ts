import { one, query } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { billingStatus, isAdmin, type BillingStatus } from './billing.js';
import { KEEP_SETTINGS_KEYS, OPTIONAL_LIMIT_KEYS, RUN_LIMITS, RUN_SETTING_DEFAULTS } from './settings.js';
import { PLAN_LIMITS, SCHEDULED_MIN_SCORE } from '../src/pricing.js';

export { SCHEDULED_MIN_SCORE };

/**
 * What an account is allowed to do — decided in one place, for every caller.
 *
 * Admins and Intensive Pass holders can drive runs and also receive scheduled
 * runs. Intensive users can tune how a run searches. Standard accounts do not drive anything — their
 * applications go out on a schedule from the preferences they saved.
 *
 * Every gate in the app reads this module rather than re-deriving the rule
 * from `isAdmin` and a pass flag, because the same rule is enforced in five
 * places (starting a run, the daily cap, saving settings, the rewriting tool,
 * the scheduler) and five copies would drift.
 */

export type Tier = 'admin' | 'intensive' | 'standard';

/** Local time is what a candidate means by "today". Scheduled runs happen at any hour of it. */
export const RUN_TIME_ZONE = process.env.RUN_TIME_ZONE?.trim() || 'Australia/Sydney';

/** Manual runs an Intensive Pass may start per local day. Admins have no cap. */
export const INTENSIVE_MANUAL_RUNS_PER_DAY = PLAN_LIMITS['intensive-pass'].manualRunsPerDay;

/** Scheduled runs per local day for customer plans. */
export const FREE_AUTO_RUNS_PER_DAY = PLAN_LIMITS.free.autoRunsPerDay;
export const JOB_SEARCH_AUTO_RUNS_PER_DAY = PLAN_LIMITS['job-search-pass'].autoRunsPerDay;
export const INTENSIVE_AUTO_RUNS_PER_DAY = PLAN_LIMITS['intensive-pass'].autoRunsPerDay;

/** Scheduled runs per local day for an operator of this installation. */
export const ADMIN_AUTO_RUNS_PER_DAY = 10;

/**
 * Where an account's own "automatic runs off" choice is kept. A settings row,
 * but deliberately not a run setting: it never reaches the bot and cannot be
 * posted through /api/settings.
 */
const AUTO_APPLY_PAUSED_KEY = 'AUTO_APPLY_PAUSED';

/**
 * Per-account admin overrides: how many listings a run reviews, and how many
 * applications one run may submit. Set by an operator to give one account
 * more or less than its plan — for cost control, or a real problem case —
 * without moving the account to a different plan.
 *
 * Stored as settings rows outside `KEEP_SETTINGS_KEYS`, the same way
 * `AUTO_APPLY_PAUSED_KEY` is: `/api/settings` never exposes them to the
 * account, and they survive the standard-tier fine-tuning reset in
 * `applyRunPolicy`, which resets everything in that key set back to the
 * product default before an operator's override ever gets a say.
 */
const ADMIN_EVALUATIONS_OVERRIDE_KEY = 'ADMIN_EVALUATIONS_OVERRIDE';
const ADMIN_MAX_APPS_OVERRIDE_KEY = 'ADMIN_MAX_APPS_OVERRIDE';

export interface AdminOverrides {
  /** Listings a run reviews. Null means the account's plan decides. */
  evaluationsPerRun: number | null;
  /** Applications one run may submit. Null means the account's own setting or plan default decides. */
  maxApplicationsPerRun: number | null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** An account's current admin overrides, or nulls where none is set. */
export async function adminOverridesFor(userId: string): Promise<AdminOverrides> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE user_id = $1 AND key = ANY($2)`,
    [userId, [ADMIN_EVALUATIONS_OVERRIDE_KEY, ADMIN_MAX_APPS_OVERRIDE_KEY]],
  );
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    evaluationsPerRun: parsePositiveInt(byKey[ADMIN_EVALUATIONS_OVERRIDE_KEY]),
    maxApplicationsPerRun: parsePositiveInt(byKey[ADMIN_MAX_APPS_OVERRIDE_KEY]),
  };
}

/**
 * Sets or clears one account's admin overrides. A `null` value clears that
 * override back to the plan default; a number is clamped to the same
 * ceiling seek-bot enforces for every account (`RUN_LIMITS`), so an operator
 * cannot hand out more than a run will actually use.
 */
export async function setAdminOverrides(
  userId: string,
  overrides: { evaluationsPerRun?: number | null; maxApplicationsPerRun?: number | null },
): Promise<void> {
  const clamp = (value: number | null | undefined, ceiling: number) =>
    value === null || value === undefined ? value : Math.max(1, Math.min(ceiling, Math.floor(value)));
  if (overrides.evaluationsPerRun !== undefined) {
    const clamped = clamp(overrides.evaluationsPerRun, RUN_LIMITS.MAX_EVALUATIONS);
    await upsertSettingRow(userId, ADMIN_EVALUATIONS_OVERRIDE_KEY, clamped ? String(clamped) : '');
  }
  if (overrides.maxApplicationsPerRun !== undefined) {
    const clamped = clamp(overrides.maxApplicationsPerRun, RUN_LIMITS.MAX_APPS_PER_RUN);
    await upsertSettingRow(userId, ADMIN_MAX_APPS_OVERRIDE_KEY, clamped ? String(clamped) : '');
  }
}

/** Employer-site applications an Intensive Pass may submit per day. */
export const INTENSIVE_EMPLOYER_SITES_PER_DAY = PLAN_LIMITS['intensive-pass'].employerSitesPerDay;


/** Listings the AI assesses in each run for the three customer plans. */
export const FREE_EVALUATIONS_PER_RUN = PLAN_LIMITS.free.evaluationsPerRun;
export const JOB_SEARCH_EVALUATIONS_PER_RUN = PLAN_LIMITS['job-search-pass'].evaluationsPerRun;
export const INTENSIVE_EVALUATIONS_PER_RUN = PLAN_LIMITS['intensive-pass'].evaluationsPerRun;

/**
 * The preferences a standard account may edit: who they are, what work they
 * want, and where and for how much. Everything else in `KEEP_SETTINGS_KEYS`
 * — match threshold, listing age, page depth, per-run and per-day ceilings,
 * cover-letter mode, standing instructions — decides how a run *behaves*, and
 * belongs to the tiers that drive runs themselves.
 */
export const BASIC_SETTINGS_KEYS = [
  'KEYWORDS',
  'EXCLUDED_COMPANIES',
  'WORK_ARRANGEMENTS',
  'ONSITE_CITY',
  'MIN_SALARY',
  'MIN_HOURLY_RATE',
] as const;

/** Plain strings: callers test keys arriving from a request against this. */
export const FINE_TUNING_KEYS: string[] = KEEP_SETTINGS_KEYS.filter(
  (key) => !(BASIC_SETTINGS_KEYS as readonly string[]).includes(key),
);

/**
 * Apply plan policy to the settings that will actually reach the bot.
 *
 * Filtering writes is not enough: an account may have advanced values saved
 * from an earlier Intensive Pass. Standard runs therefore resolve every
 * fine-tuning key back to the product default at execution time. Scheduled
 * live applications then receive their fixed safety threshold regardless of
 * any saved value.
 */
export function applyRunPolicy(
  settings: Record<string, string>,
  entitlement: Pick<
    Entitlements,
    'tier' | 'fineTune' | 'indeedApplications' | 'evaluationsPerRun' | 'humanizer' | 'maxApplicationsPerRunOverride'
  >,
  trigger: 'manual' | 'auto',
): Record<string, string> {
  const resolved = { ...settings };
  // The field was removed. An old saved value or shared .env value must not
  // keep influencing runs after it disappears from the interface.
  resolved.TARGET_ROLE = RUN_SETTING_DEFAULTS.TARGET_ROLE;
  if (!entitlement.fineTune) {
    for (const key of FINE_TUNING_KEYS) resolved[key] = RUN_SETTING_DEFAULTS[key] ?? '';
  }
  /**
   * A pass that includes Indeed adds it for every tier. An account that can
   * fine-tune keeps a board list it chose itself; the product default is
   * not a choice, and leaving Indeed off it left paying accounts on SEEK
   * alone without anyone deciding that.
   */
  if (entitlement.indeedApplications && (resolved.PLATFORMS ?? '').trim() === RUN_SETTING_DEFAULTS.PLATFORMS) {
    resolved.PLATFORMS = 'seek,indeed';
  }
  /**
   * An operator's numbers for this account win over both the plan's own
   * default and whatever the account saved — that is the point of setting
   * one. Applied after the fine-tuning reset above, so they survive for a
   * standard account whose own MAX_APPS_PER_RUN was just wiped back to the
   * product default, and before the operator pass below, which keeps any
   * digits it finds.
   */
  if (entitlement.evaluationsPerRun !== null) {
    resolved.MAX_EVALUATIONS = String(entitlement.evaluationsPerRun);
  }
  if (entitlement.maxApplicationsPerRunOverride !== null) {
    resolved.MAX_APPS_PER_RUN = String(entitlement.maxApplicationsPerRunOverride);
  }
  /**
   * The humanizer is part of a paid pass. A free run sends the grounded,
   * fact-checked draft as written and never queues for the rewriting model,
   * which also keeps paying accounts' letters from waiting behind it.
   */
  if (!entitlement.humanizer) resolved.HUMANIZER_MODE = 'off';
  if (trigger === 'auto' && entitlement.tier !== 'admin') {
    resolved.MIN_SCORE = String(SCHEDULED_MIN_SCORE);
  }
  /**
   * An operator of this installation sets their own limits, or none. A number
   * they saved on the Apply page — applications per run, per day, listings
   * reviewed — is used as given, unclamped; an empty one means no limit at
   * all. "none" reaches the bot, which honours it only alongside
   * ADMIN_UNLIMITED; an operator narrowing one run on the command line still
   * can, because those arguments come after this.
   */
  if (entitlement.tier === 'admin') {
    for (const key of OPTIONAL_LIMIT_KEYS) {
      const value = (resolved[key] ?? '').trim();
      resolved[key] = /^\d+$/.test(value) && Number(value) > 0 ? String(Number(value)) : 'none';
    }
  }
  return resolved;
}

export interface Entitlements {
  tier: Tier;
  /** May start a run by hand. */
  manualRuns: boolean;
  /** Manual runs allowed per local day; null means no cap. */
  manualRunsPerDay: number | null;
  manualRunsUsedToday: number;
  manualRunsLeftToday: number | null;
  /** Automatic runs per local day. */
  autoRunsPerDay: number;
  /** The account has switched its automatic runs off; nothing is scheduled until it switches them back on. */
  autoApplyPaused: boolean;
  /** May switch automatic runs off and on. */
  canPauseAutoApply: boolean;
  autoRunsUsedToday: number;
  /** Fixed match floor for scheduled applications; null when this tier has no schedule. */
  scheduledMinScore: number | null;
  /** Listings the schedule assesses over a full day; null without a schedule. */
  scheduledJobsPerDay: number | null;
  /** Listings the AI assesses in each run; admins keep their configured value. Reflects an operator's override, if one is set. */
  evaluationsPerRun: number | null;
  /** Applications one run may submit, forced by an operator; null when no override is set and the account's own setting or plan default applies. */
  maxApplicationsPerRunOverride: number | null;
  /** May edit the settings that change how a run behaves. */
  fineTune: boolean;
  /** May use the rewriting tool. */
  rewriteText: boolean;
  /** May limit a run to employer-site or board-hosted applications, to test one flow. */
  runScopes: boolean;
  /** May search and apply to jobs hosted on Indeed as well as SEEK. */
  indeedApplications: boolean;
  /** Cover letters are rewritten by the humanizer. Job Search Pass and Intensive Pass only. */
  humanizer: boolean;
  /**
   * Search-term suggestions from résumés left. Null means no limit. The free
   * plan gets one: enough to see what it does, and the reason to buy a pass
   * if it was useful.
   */
  searchTermSuggestionsLeft: number | null;
  timeZone: string;
}

/** What the free plan gets of the résumé-to-search-terms suggestion. */
export const FREE_SEARCH_TERM_SUGGESTIONS = 1;

export const SEARCH_TERMS_FEATURE = 'search-term-suggestion';

async function searchTermSuggestionsLeft(userId: string, tier: Tier, hasActivePass: boolean): Promise<number | null> {
  if (tier === 'admin' || hasActivePass) return null;
  const used = await one<{ n: string }>('SELECT count(*)::text AS n FROM feature_uses WHERE user_id = $1 AND feature = $2', [userId, SEARCH_TERMS_FEATURE]);
  return Math.max(0, FREE_SEARCH_TERM_SUGGESTIONS - Number(used?.n ?? 0));
}

/** Records one use, for the count above. */
export async function recordFeatureUse(userId: string, feature: string): Promise<void> {
  await query('INSERT INTO feature_uses (user_id, feature) VALUES ($1, $2)', [userId, feature]);
}

function tierFor(admin: boolean, intensive: boolean): Tier {
  if (admin) return 'admin';
  return intensive ? 'intensive' : 'standard';
}

/**
 * Scheduled runs a day.
 *
 * Intensive includes the same four-run automatic schedule as Job Search Pass,
 * in addition to its user-started runs.
 */
export function automaticRunsPerDay(tier: Tier, hasActivePass = false): number {
  if (tier === 'admin') return ADMIN_AUTO_RUNS_PER_DAY;
  if (tier === 'intensive') return INTENSIVE_AUTO_RUNS_PER_DAY;
  if (tier === 'standard') return hasActivePass ? JOB_SEARCH_AUTO_RUNS_PER_DAY : FREE_AUTO_RUNS_PER_DAY;
  return 0;
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

/** Most recent run of either kind, for the account dashboard. */
export async function latestRunStartedAt(userId: string): Promise<Date | null> {
  const rows = await query<{ started_at: Date }>(
    `SELECT started_at FROM run_starts
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId],
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
  trigger: 'manual' | 'auto' | 'admin',
  startedBy?: string | null,
): Promise<string | null> {
  const row = await one<{ id: string }>(
    `INSERT INTO run_starts (user_id, mode, trigger, started_by) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [userId, mode, trigger, startedBy ?? null],
  );
  return row?.id ?? null;
}

/** A run record for a start that was refused after all: it never reached an employer, so it spends nothing. */
export async function discardRunStart(id: string | null): Promise<void> {
  if (id) await query('DELETE FROM run_starts WHERE id = $1', [id]);
}

/** Everything about an account that decides what it may do. Facts only; no database. */
export interface EntitlementFacts {
  admin: boolean;
  billing: Pick<BillingStatus, 'paid'>;
  manualRunsUsedToday: number;
  autoRunsUsedToday: number;
  autoApplyPaused: boolean;
  overrides: AdminOverrides;
  searchTermSuggestionsLeft: number | null;
}

/**
 * The plan rules, as a pure function of the facts.
 *
 * `entitlementsFor` gathers the facts for a real account; the admin simulator
 * (server/simulate.ts) supplies invented ones. Both go through here, so a
 * simulated account is shown exactly what a real one in that state would be.
 */
export function deriveEntitlements(facts: EntitlementFacts): Entitlements {
  const { billing, overrides } = facts;
  const tier = tierFor(facts.admin, billing.paid.hasActiveIntensivePass);

  const manualRuns = tier !== 'standard';
  const manualRunsPerDay = tier === 'admin' ? null : tier === 'intensive' ? INTENSIVE_MANUAL_RUNS_PER_DAY : 0;
  const autoRunsPerDay = automaticRunsPerDay(tier, billing.paid.hasActivePass);
  const planEvaluationsPerRun = tier === 'intensive'
    ? INTENSIVE_EVALUATIONS_PER_RUN
    : billing.paid.hasActivePass
      ? JOB_SEARCH_EVALUATIONS_PER_RUN
      : FREE_EVALUATIONS_PER_RUN;
  // Anyone with a schedule can switch it off — they found a job, or want a break — and back on.
  const canPauseAutoApply = autoRunsPerDay > 0;
  /**
   * An operator's override wins over the plan's own number wherever one is
   * set, on an operator's own account as much as a customer's: a number typed
   * against an account was typed deliberately. Discarding it for admins meant
   * an account whose Limits panel read 51 reviewed every listing it found,
   * because nothing downstream ever saw the number. An admin with no override
   * still has no limit — that is what the empty field means for them.
   */
  const evaluationsPerRun = tier === 'admin'
    ? overrides.evaluationsPerRun
    : overrides.evaluationsPerRun ?? planEvaluationsPerRun;

  return {
    tier,
    manualRuns,
    manualRunsPerDay,
    manualRunsUsedToday: facts.manualRunsUsedToday,
    manualRunsLeftToday: manualRunsPerDay === null ? null : Math.max(0, manualRunsPerDay - facts.manualRunsUsedToday),
    autoRunsPerDay,
    autoRunsUsedToday: facts.autoRunsUsedToday,
    // Only an account allowed to switch automatic runs off can have them off.
    autoApplyPaused: canPauseAutoApply && facts.autoApplyPaused,
    canPauseAutoApply,
    // Admins apply at their own saved threshold; the 75% floor is for accounts nobody is steering.
    scheduledMinScore: tier !== 'admin' && autoRunsPerDay ? SCHEDULED_MIN_SCORE : null,
    scheduledJobsPerDay: autoRunsPerDay > 0 && evaluationsPerRun !== null
      ? autoRunsPerDay * evaluationsPerRun
      : null,
    evaluationsPerRun,
    maxApplicationsPerRunOverride: overrides.maxApplicationsPerRun,
    fineTune: tier !== 'standard',
    rewriteText: tier === 'admin',
    runScopes: tier === 'admin',
    indeedApplications: billing.paid.hasActivePass,
    humanizer: billing.paid.hasActivePass,
    searchTermSuggestionsLeft: facts.searchTermSuggestionsLeft,
    timeZone: RUN_TIME_ZONE,
  };
}

export async function entitlementsFor(userId: string, email?: string | null): Promise<Entitlements> {
  const admin = isAdmin(email);
  const billing = await billingStatus(userId, email);
  const tier = tierFor(admin, billing.paid.hasActiveIntensivePass);
  const autoRunsPerDay = automaticRunsPerDay(tier, billing.paid.hasActivePass);

  const [manualRunsUsedToday, autoRunsUsedToday, pausedRow, overrides, suggestionsLeft] = await Promise.all([
    tier !== 'standard' ? runsStartedToday(userId, 'manual') : Promise.resolve(0),
    autoRunsPerDay > 0 ? runsStartedToday(userId, 'auto') : Promise.resolve(0),
    one<{ value: string }>('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, AUTO_APPLY_PAUSED_KEY]),
    adminOverridesFor(userId),
    searchTermSuggestionsLeft(userId, tier, billing.paid.hasActivePass),
  ]);

  return deriveEntitlements({
    admin,
    billing,
    manualRunsUsedToday,
    autoRunsUsedToday,
    autoApplyPaused: pausedRow?.value === 'true',
    overrides,
    searchTermSuggestionsLeft: suggestionsLeft,
  });
}

/** Whether this account's cover letters go through the humanizer, for callers that only know the account id. */
export async function humanizerAllowed(userId: string): Promise<boolean> {
  const user = await one<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
  return (await entitlementsFor(userId, user?.email ?? null)).humanizer;
}

/** Switches this account's automatic runs off or back on. Callers check `canPauseAutoApply` first. */
export async function setAutoApplyPaused(userId: string, paused: boolean): Promise<void> {
  await upsertSettingRow(userId, AUTO_APPLY_PAUSED_KEY, paused ? 'true' : 'false');
}
