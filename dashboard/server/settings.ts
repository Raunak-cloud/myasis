import { query } from './db/index.js';
import { upsertSettingRow } from './db/records.js';

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
 * (GEMINI_API_KEY, STRIPE_*, CHROME_PROFILE_DIR, HUMANIZER_URL, DATABASE_URL,
 * …). Those stay in `seek-bot/.env` via `readEnv`/`writeEnv` — this is one
 * local install with one Chrome automation profile and one humanizer server
 * regardless of which account is signed in, so treating them as shared,
 * machine-level configuration (not per-user data) is intentional, not an
 * oversight.
 */
export const KEEP_SETTINGS_KEYS = [
  'KEYWORDS', 'TARGET_ROLE', 'PLATFORMS', 'WORK_ARRANGEMENTS', 'JOB_TYPES', 'ONSITE_CITY',
  'SEARCH_RADIUS_KM',
  'MIN_SALARY', 'MIN_HOURLY_RATE', 'MIN_SCORE', 'MAX_AGE_DAYS', 'MAX_APPS_PER_RUN',
  'MAX_APPS_PER_DAY', 'MAX_EVALUATIONS', 'PAGES_PER_KEYWORD',
  'COVER_LETTER_MODE', 'COVER_LETTER_TEXT_B64',
] as const;

const KEEP_SET = new Set<string>(KEEP_SETTINGS_KEYS);
const MAX_EVALUATIONS_PER_RUN = 120;

function normalizeSetting(key: string, value: string): string {
  if (key !== 'MAX_EVALUATIONS') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return value;
  return String(Math.min(MAX_EVALUATIONS_PER_RUN, Math.floor(parsed)));
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
  KEYWORDS: '',
  TARGET_ROLE: '',
  PLATFORMS: 'seek',
  WORK_ARRANGEMENTS: 'remote,hybrid,onsite',
  JOB_TYPES: '',
  ONSITE_CITY: 'Sydney',
  // 0 = no geographic limit, i.e. the behaviour before the radius existed.
  SEARCH_RADIUS_KM: '0',
  MIN_SALARY: '0',
  MIN_HOURLY_RATE: '0',
  MIN_SCORE: '60',
  MAX_AGE_DAYS: '14',
  MAX_APPS_PER_RUN: '5',
  MAX_APPS_PER_DAY: '20',
  MAX_EVALUATIONS: '40',
  PAGES_PER_KEYWORD: '1',
  COVER_LETTER_MODE: 'tailored',
  COVER_LETTER_TEXT_B64: '',
};

/**
 * Every per-account setting, resolved for a run: this account's saved value,
 * else the product default — never the shared .env. Always returns all of
 * `KEEP_SETTINGS_KEYS` so the spawned child has an explicit value for each and
 * cannot inherit another account's.
 */
export async function runSettingsForUser(userId: string): Promise<Record<string, string>> {
  const saved = await loadUserSettings(userId);
  const out: Record<string, string> = {};
  for (const key of KEEP_SETTINGS_KEYS) {
    out[key] = normalizeSetting(key, saved[key] ?? RUN_SETTING_DEFAULTS[key] ?? '');
  }
  return out;
}

export async function loadUserSettings(userId: string): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = normalizeSetting(row.key, row.value);
  return out;
}

/** Only known per-user keys are accepted; anything else is silently dropped. */
export async function saveUserSettings(
  userId: string,
  updates: Record<string, string>,
): Promise<Record<string, string>> {
  for (const [key, value] of Object.entries(updates)) {
    if (!KEEP_SET.has(key)) continue;
    await upsertSettingRow(userId, key, normalizeSetting(key, String(value ?? '')));
  }
  return loadUserSettings(userId);
}

/**
 * `/api/settings` shows shared install-level config (`env`, from
 * `readEnvSafe()`) alongside this account's own per-user settings. A
 * `KEEP_SETTINGS_KEYS` entry must NEVER be answered from `env`: the shared
 * `.env` still has real values left over from before per-user settings
 * existed (e.g. the previous single account's KEYWORDS), and falling back to
 * them for a brand-new account with no saved settings yet would leak that
 * account's search preferences into every other account's blank defaults.
 */
export function mergeWithSharedEnv(
  env: Record<string, string>,
  userSettings: Record<string, string>,
): Record<string, string> {
  const shared: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!KEEP_SET.has(key)) shared[key] = value;
  }
  return { ...shared, ...userSettings };
}
