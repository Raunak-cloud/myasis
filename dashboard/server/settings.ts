import { EMPLOYER_SOURCE_DEFAULTS } from '../../seek-bot/src/employer-source-config.js';
import { query } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { limitSearchTerms } from '../src/search-limits.js';
import { validateCoverLetterInstructions } from '../../seek-bot/src/cover-letter-policy.js';
import { USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';

/**
 * Per-run search/apply preferences (job titles, work arrangement, run
 * limits, cover-letter mode…) — what `RunPanel`/`SetupPanel` edit through
 * `/api/settings`. These used to live in the single shared `seek-bot/.env`
 * (`readEnv`/`writeEnv` in `runner.ts`), which meant one account's search
 * terms were every account's search terms. `db/migrate-files.ts` already
 * migrates exactly this key set into the `settings` table (user_id, key,
 * value) — this module is the ongoing read/write path for it.
 *
 * Deliberately NOT included here: secrets and machine-level infrastructure
 * (CELERIS_API_KEY, STRIPE_*, CHROME_PROFILE_DIR, DATABASE_URL,
 * …). Those stay in `seek-bot/.env` via `readEnv`/`writeEnv` — this is one
 * local installation
 * regardless of which account is signed in, so treating them as shared,
 * machine-level configuration (not per-user data) is intentional, not an
 * oversight.
 */
export const KEEP_SETTINGS_KEYS = [
  'APPLICATION_AI_MODEL', 'APPLICATION_AGENT_MODE',
  'APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN',
  'KEYWORDS', 'TARGET_ROLE', 'EXCLUDED_COMPANIES', 'PLATFORMS', 'SMARTRECRUITERS_COMPANIES', 'LEVER_COMPANIES', 'GREENHOUSE_BOARDS', 'PAGEUP_SITES', 'WORKDAY_SITES', 'WORK_ARRANGEMENTS', 'JOB_TYPES', 'ONSITE_CITY',
  'SEARCH_RADIUS_KM',
  'MIN_SALARY', 'MIN_HOURLY_RATE', 'MIN_SCORE', 'MAX_AGE_DAYS', 'MAX_APPS_PER_RUN',
  'MAX_APPS_PER_DAY', 'MAX_EVALUATIONS',
  'COVER_LETTER_MODE', 'COVER_LETTER_TEXT_B64', 'COVER_LETTER_INSTRUCTIONS',
  // The account's own standing instructions ("no manager roles"). Stored here
  // since launch but missing from this list, so it never reached a run.
  'AI_INSTRUCTIONS_B64',
] as const;

/** TARGET_ROLE remains only so every run explicitly blanks legacy values. */
export const USER_SETTABLE_SETTINGS_KEYS = KEEP_SETTINGS_KEYS.filter((key) => key !== 'TARGET_ROLE');
/** Distinguishes a chosen daily cap from the old hidden defaults on Get Owtomated. */
export const DAILY_APPLICATION_CAP_CHOSEN = 'DAILY_APPLICATION_CAP_CHOSEN';

const KEEP_SET = new Set<string>(KEEP_SETTINGS_KEYS);
/** Mirrors seek-bot's own clamps, so the dashboard shows what a run will really use. */
export const RUN_LIMITS: Record<string, number> = {
  MAX_EVALUATIONS: 150,
  MAX_APPS_PER_RUN: USER_RUN_LIMITS.MAX_APPS_PER_DAY,
  ...USER_RUN_LIMITS,
};

function normalizeSetting(key: string, value: string): string {
  if (key === 'MAX_APPS_PER_RUN') return String(USER_RUN_LIMITS.MAX_APPS_PER_DAY);
  if (key === 'KEYWORDS') {
    return limitSearchTerms(value);
  }
  if (key === 'EXCLUDED_COMPANIES') {
    const seen = new Set<string>();
    const companies: string[] = [];
    for (const raw of value.split(/[,;\r\n]+/)) {
      const company = raw.replace(/\s+/g, ' ').trim().slice(0, 100);
      const dedupe = company.toLowerCase();
      if (!company || seen.has(dedupe)) continue;
      seen.add(dedupe);
      companies.push(company);
      if (companies.length >= 50) break;
    }
    return companies.join(', ');
  }
  const ceiling = RUN_LIMITS[key];
  if (ceiling === undefined) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return value;
  return String(Math.min(ceiling, Math.floor(parsed)));
}

/**
 * Product defaults for a per-account setting the account has not chosen yet.
 *
 * These exist so a run never has to fall through to seek-bot/.env for one of
 * these keys. That file still holds the original single account's real values
 * (their KEYWORDS, salary floor, stack exclusions), so "unset" must resolve to
 * a neutral product default here, never to whatever the shared file happens to
 * contain. Both salary settings deliberately default to no floor rather than
 * a number: pay floors are personal preferences, and inheriting them would
 * silently discard jobs the account never chose to exclude.
 */
export const RUN_SETTING_DEFAULTS: Record<string, string> = {
  APPLICATION_AI_MODEL: 'celeris',
  APPLICATION_AGENT_MODE: 'agent-only',
  APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: 'true',
  KEYWORDS: '',
  TARGET_ROLE: '',
  EXCLUDED_COMPANIES: '',
  PLATFORMS: 'seek',
  ...EMPLOYER_SOURCE_DEFAULTS,
  WORK_ARRANGEMENTS: 'remote,hybrid,onsite',
  JOB_TYPES: '',
  ONSITE_CITY: 'Sydney',
  // 0 = no geographic limit, i.e. the behaviour before the radius existed.
  SEARCH_RADIUS_KM: '0',
  MIN_SALARY: '0',
  MIN_HOURLY_RATE: '0',
  MIN_SCORE: '60',
  MAX_AGE_DAYS: '20',
  MAX_APPS_PER_RUN: String(USER_RUN_LIMITS.MAX_APPS_PER_DAY),
  MAX_APPS_PER_DAY: String(USER_RUN_LIMITS.MAX_APPS_PER_DAY),
  MAX_EVALUATIONS: '40',
  COVER_LETTER_MODE: 'tailored',
  COVER_LETTER_INSTRUCTIONS: '',
  AI_INSTRUCTIONS_B64: '',
  COVER_LETTER_TEXT_B64: '',
};

/**
 * Every per-account setting, resolved for a run: this account's saved value,
 * else the product default — never the shared .env. Always returns all of
 * `KEEP_SETTINGS_KEYS` so the spawned child has an explicit value for each and
 * cannot inherit another account's.
 */
export async function runSettingsForUser(userId: string, options: { unlimited?: boolean } = {}): Promise<Record<string, string>> {
  return (await runSettingsSnapshotForUser(userId, options)).settings;
}

/**
 * Resolves run settings and returns the exact saved values they came from in
 * one read. The snapshot lets post-run automation use an atomic compare and
 * swap, so an edit made while a run is active is never overwritten.
 */
export async function runSettingsSnapshotForUser(
  userId: string,
  options: { unlimited?: boolean } = {},
): Promise<{ settings: Record<string, string>; saved: Record<string, string> }> {
  const saved = await loadUserSettings(userId);
  const out: Record<string, string> = {};
  for (const key of KEEP_SETTINGS_KEYS) {
    // Operators may leave review capacity unbounded. Applications always
    // use the shared daily allowance, including with legacy saved values.
    const fallback = options.unlimited && (OPTIONAL_LIMIT_KEYS as readonly string[]).includes(key) ? '' : RUN_SETTING_DEFAULTS[key] ?? '';
    const value = saved[key] ?? fallback;
    // Review limits can be overridden. Listing age, selected
    // daily caps, search terms and pages stay bounded for everyone.
    out[key] = options.unlimited && key !== 'KEYWORDS' && key !== 'MAX_APPS_PER_RUN' && !(key in USER_RUN_LIMITS) ? value : normalizeSetting(key, value);
  }
  return { settings: out, saved };
}

/** Operators may leave the review limit empty; the daily application maximum always applies. */
export const OPTIONAL_LIMIT_KEYS = ['MAX_EVALUATIONS'] as const;

export async function loadUserSettings(userId: string): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, string> = {};
  // Stored verbatim; the ceilings are applied when a run is built, which is
  // the only place they can be waived for an operator of this installation.
  for (const row of rows) {
    if (row.key === 'PAGES_PER_KEYWORD') continue; // Retired; old saved values have no effect.
    if (row.key === 'APPLICATION_AI_MODEL') out[row.key] = 'celeris';
    else if (row.key === 'APPLICATION_AGENT_MODE') out[row.key] = 'agent-only';
    else if (row.key === 'APPLICATION_AGENT_MODE_AUTHORIZED') continue;
    else if (!row.key.startsWith('APPLICATION_AI_')) out[row.key] = row.value;
  }
  return out;
}

/** Only known per-user keys are accepted; anything else is silently dropped. */
export async function saveUserSettings(
  userId: string,
  updates: Record<string, string>,
): Promise<Record<string, string>> {
  if (updates.COVER_LETTER_INSTRUCTIONS !== undefined) {
    updates = { ...updates, COVER_LETTER_INSTRUCTIONS: validateCoverLetterInstructions(updates.COVER_LETTER_INSTRUCTIONS) };
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!KEEP_SET.has(key)) continue;
    const raw = String(value ?? '').slice(0, 20_000);
    await upsertSettingRow(userId, key, key === 'EXCLUDED_COMPANIES' || key === 'KEYWORDS' ? normalizeSetting(key, raw) : raw);
  }
  return loadUserSettings(userId);
}

/**
 * Saves AI-renewed search terms only if the account still has exactly the
 * value it had when the run began. UPDATE ... WHERE ... RETURNING makes the
 * check and write one database operation; a user's intervening edit wins.
 */
export async function replaceSearchTermsIfUnchanged(
  userId: string,
  expectedValue: string,
  nextValue: string,
): Promise<boolean> {
  const normalized = normalizeSetting('KEYWORDS', nextValue);
  const updated = await query<{ value: string }>(
    `UPDATE settings
        SET value = $3
      WHERE user_id = $1 AND key = 'KEYWORDS' AND value = $2
      RETURNING value`,
    [userId, expectedValue, normalized],
  );
  return updated.length === 1;
}
