import { one, query } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { billingStatus, isAdmin, type BillingStatus } from './billing.js';
import { KEEP_SETTINGS_KEYS, OPTIONAL_LIMIT_KEYS, RUN_LIMITS, RUN_SETTING_DEFAULTS } from './settings.js';
import { PLAN_LIMITS, SCHEDULED_MIN_SCORE, CUSTOM_MIN_SCORE, MAX_MATCH_SCORE } from '../src/pricing.js';
import type { RunDevice } from '../src/run-device.js';
import { countedRunSql, RUN_TIME_ZONE } from './run-accounting.js';
import { limitSearchTerms } from '../src/search-limits.js';
import { boundedUserRunLimit, dailyApplicationLimit, USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';

export { SCHEDULED_MIN_SCORE, RUN_TIME_ZONE };

/**
 * What an account is allowed to do — decided in one place, for every caller.
 *
 * Every account explicitly enables its schedule. Plans limit scheduled runs and job
 * reviews; Semi auto confirmations continue an existing preparation run.
 *
 * Every gate in the app reads this module rather than re-deriving the rule
 * from `isAdmin` and a pass flag, because the same rule is enforced in several
 * places (starting a run, saving settings,
 * the scheduler) and separate copies would drift.
 */

export type Tier = 'admin' | 'intensive' | 'standard';

/** Local time is what a candidate means by "today". Scheduled runs happen at any hour of it. */

/** Scheduled runs per local day for customer plans. */
const FREE_AUTO_RUNS_PER_DAY = PLAN_LIMITS.free.autoRunsPerDay;
const ESSENTIAL_AUTO_RUNS_PER_DAY = PLAN_LIMITS['essential-pass'].autoRunsPerDay;
const JOB_SEARCH_AUTO_RUNS_PER_DAY = PLAN_LIMITS['job-search-pass'].autoRunsPerDay;
const INTENSIVE_AUTO_RUNS_PER_DAY = PLAN_LIMITS['intensive-pass'].autoRunsPerDay;

/** Scheduled runs per local day for an operator of this installation. */
const ADMIN_AUTO_RUNS_PER_DAY = 4;

/** Per-account review overrides. Legacy application overrides are cleared,
 * because normal runs use the shared daily application allowance. */
const ADMIN_EVALUATIONS_OVERRIDE_KEY = 'ADMIN_EVALUATIONS_OVERRIDE';
const ADMIN_MAX_APPS_OVERRIDE_KEY = 'ADMIN_MAX_APPS_OVERRIDE';

interface AdminOverrides {
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
    // Legacy per-run application overrides no longer restrict normal runs.
    maxApplicationsPerRun: null,
  };
}

/**
 * Sets or clears one account's admin overrides. A `null` value clears that
 * override back to the plan default. Customer accounts stay within the hard
 * bot ceilings; an administrator's own account may use any positive safe
 * integer because its runs carry `ADMIN_UNLIMITED` and the bot deliberately
 * lifts those ceilings for that account.
 */
export async function setAdminOverrides(
  userId: string,
  overrides: { evaluationsPerRun?: number | null; maxApplicationsPerRun?: number | null },
  options: { targetIsAdmin?: boolean } = {},
): Promise<void> {
  const clamp = (value: number | null | undefined, ceiling: number) => value === null || value === undefined
    ? value
    : Math.max(1, Math.min(options.targetIsAdmin ? Number.MAX_SAFE_INTEGER : ceiling, Math.floor(value)));
  if (overrides.evaluationsPerRun !== undefined) {
    const clamped = clamp(overrides.evaluationsPerRun, RUN_LIMITS.MAX_EVALUATIONS);
    await upsertSettingRow(userId, ADMIN_EVALUATIONS_OVERRIDE_KEY, clamped ? String(clamped) : '');
  }
  if (overrides.maxApplicationsPerRun !== undefined) {
    // Clear deprecated overrides supplied by older admin clients.
    await upsertSettingRow(userId, ADMIN_MAX_APPS_OVERRIDE_KEY, '');
  }
}

/** Employer-site applications an Intensive Pass may submit per day. */
export const INTENSIVE_EMPLOYER_SITES_PER_DAY = PLAN_LIMITS['intensive-pass'].employerSitesPerDay;


/** Listings the AI assesses in each run for the four customer plans. */
const FREE_EVALUATIONS_PER_RUN = PLAN_LIMITS.free.evaluationsPerRun;
const ESSENTIAL_EVALUATIONS_PER_RUN = PLAN_LIMITS['essential-pass'].evaluationsPerRun;
const JOB_SEARCH_EVALUATIONS_PER_RUN = PLAN_LIMITS['job-search-pass'].evaluationsPerRun;
const INTENSIVE_EVALUATIONS_PER_RUN = PLAN_LIMITS['intensive-pass'].evaluationsPerRun;

/**
 * The preferences a standard account may edit: who they are, what work they
 * want, and where and for how much. Everything else in `KEEP_SETTINGS_KEYS`
 * — match threshold, listing age, page depth, per-run and per-day ceilings,
 * cover-letter mode, standing instructions — decides how a run *behaves*, and
 * belongs to the tiers that drive runs themselves.
 */
const BASIC_SETTINGS_KEYS = [
  'KEYWORDS',
  'EXCLUDED_COMPANIES',
  'WORK_ARRANGEMENTS',
  'ONSITE_CITY',
  'MIN_SALARY',
  'MIN_HOURLY_RATE',
  'COVER_LETTER_INSTRUCTIONS',
] as const;

/** Plain strings: callers test keys arriving from a request against this. */
const FINE_TUNING_KEYS: string[] = KEEP_SETTINGS_KEYS.filter(
  (key) => !(BASIC_SETTINGS_KEYS as readonly string[]).includes(key),
);

/** Active Search may refine matching without receiving Intensive's run controls or standing instructions. */
const ADVANCED_FILTER_KEYS = ['MIN_SCORE', 'MAX_AGE_DAYS'] as const;

export function mayEditRunSetting(key: string, entitlement: Pick<Entitlements, 'fineTune' | 'advancedFilters'> & Partial<Pick<Entitlements, 'tier'>>): boolean {
  if (key === 'MAX_APPS_PER_RUN') return false;
  if (key === 'APPLICATION_AI_MODEL' || key === 'APPLICATION_AGENT_MODE' || key === 'APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN') return entitlement.tier === 'admin';
  if (!FINE_TUNING_KEYS.includes(key)) return true;
  return entitlement.fineTune
    || (entitlement.advancedFilters && (ADVANCED_FILTER_KEYS as readonly string[]).includes(key));
}

/**
 * Apply plan policy to the settings that will actually reach the bot.
 *
 * Filtering writes is not enough: an account may have advanced values saved
 * from an earlier Intensive Pass. Standard runs therefore resolve every
 * fine-tuning key back to the product default at execution time. Scheduled
 * live applications use a fixed threshold on Free and Essential, while
 * Active Search and Get Owtomated use the customer's chosen threshold.
 */
/** Set once the account picks its job boards itself; from then on its list is used exactly as picked. */
export const PLATFORMS_CHOSEN_KEY = 'PLATFORMS_CHOSEN';

/**
 * The boards a run uses. A list the account picked is used exactly as
 * picked. Otherwise the plan decides: SEEK and Indeed when the pass includes
 * Indeed, SEEK alone when it does not.
 *
 * A saved "seek" is not itself a choice: the run screen saves every field when
 * a run starts, so the product default lands in the database for accounts
 * that never looked at the boards. The marker is the choice. Without it, a
 * person who unticked Indeed got Indeed anyway (Rinu Thapa, 5 Oct): her "seek"
 * read exactly like the default and was widened back to both boards.
 */
export function effectivePlatforms(
  saved: Record<string, string | undefined>,
  entitlement: Pick<Entitlements, 'indeedApplications'>,
): string {
  const value = (saved.PLATFORMS ?? RUN_SETTING_DEFAULTS.PLATFORMS).trim() || RUN_SETTING_DEFAULTS.PLATFORMS;
  if (saved[PLATFORMS_CHOSEN_KEY] === '1') return value;
  return entitlement.indeedApplications && value === RUN_SETTING_DEFAULTS.PLATFORMS ? 'seek,indeed' : value;
}

export function applyRunPolicy(
  settings: Record<string, string>,
  entitlement: Pick<
    Entitlements,
    'tier' | 'fineTune' | 'advancedFilters' | 'indeedApplications' | 'evaluationsPerRun' | 'maxApplicationsPerRunOverride'
  >,
  trigger: 'manual' | 'auto',
  /** Whether the account picked its boards itself (see effectivePlatforms). */
  boardsChosen = false,
): Record<string, string> {
  const resolved = { ...settings };
  delete resolved.PAGES_PER_KEYWORD; // Retired discovery depth cannot influence runs.
  // Search traffic has the same cap for posted overrides, scheduled runs and admins.
  resolved.KEYWORDS = limitSearchTerms(resolved.KEYWORDS ?? '');
  // The field was removed. An old saved value or shared .env value must not
  // keep influencing runs after it disappears from the interface.
  resolved.TARGET_ROLE = RUN_SETTING_DEFAULTS.TARGET_ROLE;
  if (!entitlement.fineTune) {
    for (const key of FINE_TUNING_KEYS) {
      if (!mayEditRunSetting(key, entitlement)) resolved[key] = RUN_SETTING_DEFAULTS[key] ?? '';
    }
  }
  // A pass that includes Indeed adds it, unless the account picked its boards itself.
  resolved.PLATFORMS = effectivePlatforms({ PLATFORMS: resolved.PLATFORMS, [PLATFORMS_CHOSEN_KEY]: boardsChosen ? '1' : '' }, entitlement);
  // Review overrides remain independent of the application allowance.
  if (entitlement.evaluationsPerRun !== null) {
    resolved.MAX_EVALUATIONS = String(entitlement.evaluationsPerRun);
  }
  // Ignore old per-run defaults and operator overrides. The shared daily
  // allowance and available credits are the application boundaries.
  resolved.MAX_APPS_PER_RUN = String(USER_RUN_LIMITS.MAX_APPS_PER_DAY);
  if (entitlement.tier !== 'admin' && (trigger === 'auto' || entitlement.advancedFilters)) {
    const requestedScore = Number(resolved.MIN_SCORE);
    resolved.MIN_SCORE = String(entitlement.advancedFilters && Number.isFinite(requestedScore)
      ? Math.max(CUSTOM_MIN_SCORE, Math.min(MAX_MATCH_SCORE, requestedScore))
      : SCHEDULED_MIN_SCORE);
  }
  // An empty operator review limit means no review ceiling.
  if (entitlement.tier === 'admin') {
    for (const key of OPTIONAL_LIMIT_KEYS) {
      const value = (resolved[key] ?? '').trim();
      resolved[key] = /^\d+$/.test(value) && Number(value) > 0 ? String(Number(value)) : 'none';
    }
  }
  for (const key of Object.keys(USER_RUN_LIMITS) as Array<keyof typeof USER_RUN_LIMITS>) {
    if (key === 'MAX_APPS_PER_DAY') {
      resolved[key] = String(dailyApplicationLimit(resolved[key]));
    } else resolved[key] = String(boundedUserRunLimit(key, resolved[key], Number(RUN_SETTING_DEFAULTS[key])));
  }
  return resolved;
}

export interface Entitlements {
  tier: Tier;
  /** Every account starts its own runs within its plan allowance. */
  manualRuns: boolean;
  /** Legacy onboarding indicator; completing it never enables scheduling. */
  firstRunRequired: boolean;
  /** Scheduled starts per rolling 24 hours (wire name retained). */
  autoRunsPerDay: number;
  /** True until the user explicitly enables their saved schedule. */
  autoApplyPaused: boolean;
  /** The user may start, pause and resume a saved schedule. */
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
  /** May refine match score and listing age without receiving Intensive's direct run controls. */
  advancedFilters: boolean;
  /** May limit a run to employer-site or board-hosted applications, to test one flow. */
  runScopes: boolean;
  /** May search and apply to jobs hosted on Indeed as well as SEEK. */
  indeedApplications: boolean;
  /**
   * Search-term suggestions from resumes left. Null means no limit. The free
   * plan gets one: enough to see what it does, and the reason to buy a pass
   * if it was useful.
   */
  searchTermSuggestionsLeft: number | null;
  timeZone: string;
}

/** What the free plan gets of the resume-to-search-terms suggestion. */
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
 * Intensive includes the same four-run automatic schedule as Active Search.
 */
export function automaticRunsPerDay(tier: Tier, plan: 'free' | 'essential' | 'active' = 'free'): number {
  if (tier === 'admin') return ADMIN_AUTO_RUNS_PER_DAY;
  if (tier === 'intensive') return INTENSIVE_AUTO_RUNS_PER_DAY;
  if (tier === 'standard' && plan === 'active') return JOB_SEARCH_AUTO_RUNS_PER_DAY;
  if (tier === 'standard' && plan === 'essential') return ESSENTIAL_AUTO_RUNS_PER_DAY;
  if (tier === 'standard') return FREE_AUTO_RUNS_PER_DAY;
  return 0;
}

/**
 * Started live discovery runs in the last 24 hours, including failed or paused
 * attempts. Approval-only submissions continue an existing prepared application.
 *
 * The comparison is written as a round trip through the local zone —
 * truncate in local time, then read the result back as an instant — so the
 * day boundary is the candidate's midnight rather than the database
 * server's, whatever the database is configured to think local means.
 */
async function automaticRunsStartedToday(userId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM run_starts r
      WHERE r.user_id = $1
        AND r.trigger IN ('auto', 'onboarding', 'manual') AND NOT r.approval_only
        AND r.mode = 'live'
        AND r.started_at > now() - interval '24 hours'`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** A first run with completed work, including an operator's real submissions. */
async function hasCompletedFirstRun(userId: string): Promise<boolean> {
  const row = await one<{ complete: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM run_starts r
        WHERE r.user_id = $1
          AND r.mode = 'live'
          AND ${countedRunSql('r')}
          AND (r.trigger IN ('auto', 'onboarding') OR (r.trigger = 'admin' AND r.applied > 0))
     ) AS complete`,
    [userId],
  );
  return row?.complete === true;
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
 * One started run. Written once the child is actually spawned so scheduler
 * restarts do not create duplicate automatic runs.
 */
export async function recordRunStart(
  userId: string,
  mode: string,
  trigger: 'manual' | 'auto' | 'admin' | 'onboarding',
  startedBy?: string | null,
  initiatorDevice?: RunDevice | null,
  approvalOnly = false,
): Promise<string | null> {
  const row = await one<{ id: string }>(
    `INSERT INTO run_starts (user_id, mode, trigger, started_by, initiator_device, approval_only) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [userId, mode, trigger, startedBy ?? null, trigger === 'auto' ? null : initiatorDevice ?? null, approvalOnly],
  );
  return row?.id ?? null;
}

/** A run record for a start that was refused after all: it never reached an employer, so it spends nothing. */
export async function discardRunStart(id: string | null): Promise<void> {
  if (id) await query('DELETE FROM run_starts WHERE id = $1', [id]);
}

/** Everything about an account that decides what it may do. Facts only; no database. */
interface EntitlementFacts {
  admin: boolean;
  billing: Pick<BillingStatus, 'paid'>;
  autoRunsUsedToday: number;
  autoApplyPaused: boolean;
  hasSuccessfulRun: boolean;
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
  const scheduledPlan = billing.paid.hasActiveJobSearchPass
    ? 'active'
    : billing.paid.hasActiveEssentialPass
      ? 'essential'
      : 'free';

  const manualRuns = true;
  const autoRunsPerDay = automaticRunsPerDay(tier, scheduledPlan);
  const firstRunRequired = tier !== 'admin' && autoRunsPerDay > 0 && !facts.hasSuccessfulRun;
  const planEvaluationsPerRun = tier === 'intensive'
    ? INTENSIVE_EVALUATIONS_PER_RUN
    : billing.paid.hasActiveJobSearchPass
      ? JOB_SEARCH_EVALUATIONS_PER_RUN
      : billing.paid.hasActiveEssentialPass
        ? ESSENTIAL_EVALUATIONS_PER_RUN
      : FREE_EVALUATIONS_PER_RUN;
  // Anyone with a schedule can switch it off — they found a job, or want a break — and back on.
  const canPauseAutoApply = true;
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
  const advancedFilters = tier !== 'standard' || billing.paid.hasActiveJobSearchPass;

  return {
    tier,
    manualRuns,
    firstRunRequired,
    autoRunsPerDay,
    autoRunsUsedToday: facts.autoRunsUsedToday,
    // Only an account allowed to switch automatic runs off can have them off.
    autoApplyPaused: facts.autoApplyPaused,
    canPauseAutoApply,
    // Every plan starts at 60%; editable plans may choose a higher threshold.
    scheduledMinScore: tier !== 'admin' && autoRunsPerDay
      ? (advancedFilters ? CUSTOM_MIN_SCORE : SCHEDULED_MIN_SCORE)
      : null,
    scheduledJobsPerDay: autoRunsPerDay > 0 && evaluationsPerRun !== null
      ? autoRunsPerDay * evaluationsPerRun
      : null,
    evaluationsPerRun,
    maxApplicationsPerRunOverride: overrides.maxApplicationsPerRun,
    fineTune: tier !== 'standard',
    advancedFilters,
    runScopes: tier === 'admin',
    indeedApplications: billing.paid.hasActiveJobSearchPass || billing.paid.hasActiveIntensivePass,
    searchTermSuggestionsLeft: facts.searchTermSuggestionsLeft,
    timeZone: RUN_TIME_ZONE,
  };
}

export async function entitlementsFor(userId: string, email?: string | null): Promise<Entitlements> {
  const admin = isAdmin(email);
  const billing = await billingStatus(userId, email);
  const tier = tierFor(admin, billing.paid.hasActiveIntensivePass);
  const scheduledPlan = billing.paid.hasActiveJobSearchPass
    ? 'active'
    : billing.paid.hasActiveEssentialPass
      ? 'essential'
      : 'free';
  const autoRunsPerDay = automaticRunsPerDay(tier, scheduledPlan);

  const [autoRunsUsedToday, pausedRow, overrides, suggestionsLeft, hasSuccessfulRun] = await Promise.all([
    autoRunsPerDay > 0 ? automaticRunsStartedToday(userId) : Promise.resolve(0),
    one<{ value: string }>("SELECT (NOT enabled)::text AS value FROM application_schedules WHERE user_id = $1", [userId]),
    adminOverridesFor(userId),
    searchTermSuggestionsLeft(userId, tier, billing.paid.hasActivePass),
    admin ? Promise.resolve(true) : hasCompletedFirstRun(userId),
  ]);

  return deriveEntitlements({
    admin,
    billing,
    autoRunsUsedToday,
    autoApplyPaused: pausedRow?.value !== 'false',
    hasSuccessfulRun,
    overrides,
    searchTermSuggestionsLeft: suggestionsLeft,
  });
}
