import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { paymentsState } from './billing.js';
import { BOT_DIR, deploying, readEnv, runner, writeEnv } from './runner.js';
import { KEEP_SETTINGS_KEYS } from './settings.js';
import { stopAllSignins } from './signin.js';

/**
 * The installation's configuration, edited from the admin dashboard.
 *
 * Everything machine-level lives in seek-bot/.env: API keys, the humanizer,
 * pacing, retention. Until now the only way to change any of it was a shell
 * on the server, which for a two-line change meant nano, a typo, and a
 * restart that may or may not have been needed. This is the same file behind
 * a form, the way a hosting dashboard shows environment variables.
 *
 * Three rules keep it from being a foot-gun:
 *
 * - A secret is never sent back to the browser. The form shows that it is
 *   set and how long it is; typing a new value replaces it.
 * - A key that could lock the operator out of this very dashboard — the
 *   database, sign-in, the session secret — is shown but not editable. A
 *   typo there cannot be fixed from a dashboard that no longer opens.
 * - A key the server process already carries in its environment (pm2's
 *   ecosystem file) is shown as such and refused, because a file write
 *   would be silently ignored in favour of the process value.
 */

export type Kind = 'text' | 'secret' | 'number' | 'boolean' | 'url' | 'choice';

interface Spec {
  key: string;
  label: string;
  help: string;
  kind: Kind;
  /** For a choice: the allowed values, as stored. */
  options?: Array<{ value: string; label: string }>;
  /** Read once at boot, so a change waits for a restart to take effect. */
  restart?: boolean;
}

interface GroupSpec {
  key: string;
  title: string;
  note?: string;
  /** A one-line verdict across the top of the group, from the file as it stands. */
  banner?: (env: Record<string, string>) => GroupBanner | undefined;
  keys: Spec[];
}

/** Why a key is not editable here. Each names the place it is changed instead. */
const LOCKED: Record<string, string> = {
  DATABASE_URL: 'A wrong value takes the dashboard down, so it is changed on the server.',
  SITE_AUTH_SECRET: 'Changing it signs everyone out, including you. Changed on the server.',
  GOOGLE_CLIENT_ID: 'A wrong value breaks sign-in for everyone, including you. Changed on the server.',
  GOOGLE_CLIENT_SECRET: 'A wrong value breaks sign-in for everyone, including you. Changed on the server.',
  OAUTH_REDIRECT_URI: 'Part of sign-in. Changed on the server.',
  APP_BASE_URL: 'Sign-in and payments redirect here. Changed on the server.',
  ADMIN_EMAILS: 'Managed in the Users tab, where you cannot remove yourself.',
};

/**
 * Keys a run overrides per account, so the file's value never reaches
 * anything. Hidden rather than shown disabled: an operator who edits one
 * and sees nothing happen has been misled, not helped.
 */
const PER_ACCOUNT = new Set<string>([
  ...KEEP_SETTINGS_KEYS,
  'CHROME_PROFILE_DIR', 'EXCLUDED_DOMAINS', 'EXPERIENCE_SUMMARY', 'EXTERNAL_ATTEMPTS_TODAY',
  'GMAIL_BROWSER_ACCOUNT', 'MIN_SCORE', 'PROFILE_PATH', 'RESUME_ALLOW_UPLOAD', 'SEARCH_LOCATION',
  'SECURITY_CLEARANCE', 'SKILLS', 'DRY_RUN', 'DATA_DIR', 'CDP_PORT',
]);

const GROUPS: GroupSpec[] = [
  {
    key: 'payments',
    title: 'Payments',
    banner: paymentsBanner,
    note: 'Both sets of keys are kept; the switch says which one checkout uses. Test mode accepts only Stripe test cards and declines real ones.',
    keys: [
      {
        key: 'STRIPE_MODE', label: 'Mode', help: 'Live charges real cards. Test uses the test keys below and Stripe test cards such as 4242 4242 4242 4242.',
        kind: 'choice', options: [{ value: 'live', label: 'Live: real money' }, { value: 'test', label: 'Test: no real money' }],
      },
      { key: 'STRIPE_SECRET_KEY', label: 'Live secret key', help: 'Starts with sk_live_. From Developers → API keys with Test mode off.', kind: 'secret' },
      { key: 'STRIPE_WEBHOOK_SECRET', label: 'Live webhook signing secret', help: 'Starts with whsec_. From the live endpoint under Developers → Webhooks.', kind: 'secret' },
      { key: 'STRIPE_TEST_SECRET_KEY', label: 'Test secret key', help: 'Starts with sk_test_. From Developers → API keys with Test mode on.', kind: 'secret' },
      { key: 'STRIPE_TEST_WEBHOOK_SECRET', label: 'Test webhook signing secret', help: 'From a second endpoint at the same URL, created with Test mode on.', kind: 'secret' },
      { key: 'STRIPE_AUTOMATIC_TAX', label: 'Automatic GST', help: 'Let Stripe Tax add GST at checkout. Needs tax settings completed in Stripe.', kind: 'boolean' },
    ],
  },
  {
    key: 'models',
    title: 'Models',
    keys: [
      { key: 'CELERIS_API_KEY', label: 'Celeris API key', help: 'Drives the browser agent and every structured model call. Required.', kind: 'secret' },
      { key: 'CELERIS_BASE_URL', label: 'Celeris base URL', help: 'Root only; the model id is added per request.', kind: 'url' },
      { key: 'CELERIS_TIMEOUT_MS', label: 'Celeris timeout (ms)', help: 'How long one model call may take before it is abandoned.', kind: 'number' },
      { key: 'CELERIS_MAX_OUTPUT_TOKENS', label: 'Celeris reply limit (tokens)', help: 'The longest reply one model call may give. Celeris stops at 2,048 when none is sent; the default here is 8,192.', kind: 'number' },
      { key: 'GEMINI_API_KEY', label: 'Gemini API key', help: 'Cover letters only. Not needed when every account reuses a fixed letter.', kind: 'secret' },
      { key: 'GEMINI_MODEL', label: 'Gemini model', help: 'The model that drafts cover letters.', kind: 'text' },
    ],
  },
  {
    key: 'agent',
    title: 'Browser agent limits',
    note: 'An agent loop has no natural end; these bound one application in steps, time and spend.',
    keys: [
      { key: 'AGENT_MAX_STEPS', label: 'Max steps per application', help: 'Actions the agent may take on one application before giving up.', kind: 'number' },
      { key: 'AGENT_MAX_STEPS_PER_PAGE', label: 'Max steps per page', help: 'Actions on one page before it is treated as stuck.', kind: 'number' },
      { key: 'AGENT_MAX_MS', label: 'Max time per application (ms)', help: 'Wall-clock ceiling for one application.', kind: 'number' },
      { key: 'AGENT_BUDGET_USD', label: 'Spend ceiling per application (USD)', help: '0 means no ceiling.', kind: 'number' },
      { key: 'AGENT_ESCALATE_AFTER', label: 'Escalate after stalls', help: 'Turns with no page change before switching to the reasoning model.', kind: 'number' },
      { key: 'AGENT_SCREENSHOTS', label: 'Screenshots on stall', help: 'Attach a screenshot once a step stalls.', kind: 'boolean' },
      { key: 'AGENT_MAX_TRANSCRIPT_TOKENS', label: 'Max transcript tokens', help: 'How much history the agent carries between steps.', kind: 'number' },
    ],
  },
  {
    key: 'humanizer',
    title: 'Humanizer',
    note: 'Rewrites cover letters in natural words. For Featherless: URL https://api.featherless.ai, model authormist/authormist-originality, and your API key. Leave the URL empty to switch it off.',
    banner: humanizerBanner,
    keys: [
      { key: 'HUMANIZER_URL', label: 'Humanizer URL', help: 'A hosted OpenAI-compatible API such as https://api.featherless.ai, or a llama.cpp server.', kind: 'url' },
      { key: 'HUMANIZER_API_KEY', label: 'API key', help: 'For a hosted API. Leave empty for a llama.cpp server.', kind: 'secret' },
      { key: 'HUMANIZER_MODEL', label: 'Model name', help: 'As the endpoint knows it. On Featherless: authormist/authormist-originality.', kind: 'text' },
      { key: 'HUMANIZER_MODE', label: 'Mode', help: 'Empty for the selective pass, "always" to rewrite every letter, "off" to disable.', kind: 'text' },
      { key: 'HUMANIZER_REQUIRED', label: 'Required', help: 'Refuse to start a writing run while the humanizer is down.', kind: 'boolean' },
      { key: 'HUMANIZER_TIMEOUT_MS', label: 'Request timeout (ms)', help: 'One rewrite request.', kind: 'number' },
      { key: 'HUMANIZER_REWRITE_BUDGET_MS', label: 'Rewrite budget (ms)', help: 'Total time allowed for all attempts on one letter.', kind: 'number' },
      { key: 'HUMANIZER_REPETITION_PENALTY', label: 'Repetition penalty', help: 'How hard a rewrite is pushed off the draft wording. 1.0 is off and returns a near copy; the default is 1.1.', kind: 'number' },
      { key: 'HUMANIZER_TOP_K', label: 'Top-k', help: 'How many candidate words the rewrite chooses between. The default is 40.', kind: 'number' },
      { key: 'HUMANIZER_MAX_CHARS', label: 'Max letter length (chars)', help: 'Letters longer than this are not rewritten.', kind: 'number' },
    ],
  },
  {
    key: 'pacing',
    title: 'Pacing',
    note: 'SEEK walls and Indeed CAPTCHAs both appeared after about 44 applications in a day. Raising these invites the same.',
    keys: [
      { key: 'MIN_DELAY_MS', label: 'Min gap after a submission (ms)', help: '', kind: 'number' },
      { key: 'MAX_DELAY_MS', label: 'Max gap after a submission (ms)', help: '', kind: 'number' },
      { key: 'MIN_NON_SUBMIT_DELAY_MS', label: 'Min gap after a skip (ms)', help: 'After an attempt that submitted nothing.', kind: 'number' },
      { key: 'MAX_NON_SUBMIT_DELAY_MS', label: 'Max gap after a skip (ms)', help: '', kind: 'number' },
      { key: 'SEARCH_DELAY_MS', label: 'Gap between searches (ms)', help: '', kind: 'number' },
      { key: 'FIT_CONCURRENCY', label: 'Fit checks at once', help: 'Parallel model calls while ranking listings.', kind: 'number' },
      { key: 'FRICTION_ABORT', label: 'Friction abort', help: 'Blocked attempts in a row before the run stops itself.', kind: 'number' },
      { key: 'MAX_EXTERNAL_PER_DAY', label: 'Employer-site applications per day', help: 'Across all accounts.', kind: 'number' },
      { key: 'ALLOW_EXTERNAL_APPLY', label: 'Allow employer-site applications', help: 'Off keeps every run on the job boards.', kind: 'boolean' },
    ],
  },
  {
    key: 'browser',
    title: 'Browser',
    keys: [
      { key: 'CHROME_PATH', label: 'Chrome executable', help: 'Full path on the server.', kind: 'text' },
      { key: 'HEADLESS', label: 'Headless', help: 'Keep off: headless is what bot detection looks for.', kind: 'boolean' },
      { key: 'BROWSER_CONNECT_CDP', label: 'Attach to a shared browser', help: 'Keep off: each run needs its own Chrome on its own profile.', kind: 'boolean' },
      { key: 'CDP_HOST', label: 'CDP host', help: 'Only used when attaching to a shared browser.', kind: 'text' },
    ],
  },
  {
    key: 'captcha',
    title: 'CAPTCHA solving',
    note: 'Takes effect on the next run. A challenge no solver clears skips that job.',
    banner: captchaBanner,
    keys: [
      {
        key: 'CAPTCHA_SOLVER', label: 'Solver', help: 'Each solve is billed to the CapMonster balance.',
        kind: 'choice', options: [
          { value: 'off', label: 'Off' },
          { value: 'capmonster', label: 'CapMonster Cloud' },
        ],
      },
      { key: 'CAPMONSTER_API_KEY', label: 'CapMonster API key', help: 'From dash.capmonster.cloud. Solves Turnstile, Cloudflare challenges and reCAPTCHA v2; not hCaptcha.', kind: 'secret' },
      { key: 'CAPMONSTER_RECAPTCHA_V3', label: 'Replace reCAPTCHA v3 tokens', help: 'Keep off unless a site is rejecting applications. Every v3 check is then paid for, and in testing CapMonster tokens scored 0.1 to 0.3 while this browser scored 0.3 to 0.7 on its own.', kind: 'boolean' },
      { key: 'CAPMONSTER_V3_SITES', label: 'v3: only on these sites', help: 'Comma-separated hostnames, e.g. jobs.example.com. Empty means every site that uses v3.', kind: 'text' },
      { key: 'CAPMONSTER_V3_MIN_SCORE', label: 'v3: score to ask for', help: '0.1 to 0.9. Default 0.7. A request, not a guarantee.', kind: 'number' },
    ],
  },
  {
    key: 'email',
    title: 'Email',
    keys: [
      { key: 'RESEND_API_KEY', label: 'Resend API key', help: 'For the evening summary email.', kind: 'secret' },
      { key: 'RESEND_FROM', label: 'From address', help: 'Must be on a domain verified in Resend.', kind: 'text' },
      { key: 'DASHBOARD_URL', label: 'Dashboard link in emails', help: '', kind: 'url' },
    ],
  },
  {
    key: 'server',
    title: 'Server',
    keys: [
      { key: 'RUN_TIME_ZONE', label: 'Time zone', help: 'Midnight here is when daily allowances reset.', kind: 'text', restart: true },
      { key: 'TRACE_RETENTION_DAYS', label: 'Keep run traces (days)', help: 'Older traces are deleted daily.', kind: 'number', restart: true },
      { key: 'VISIT_RETENTION_DAYS', label: 'Keep visitor records (days)', help: '', kind: 'number', restart: true },
      { key: 'VISIT_HOME_COUNTRY', label: 'Home country', help: 'Two-letter code. Visitors elsewhere are listed separately.', kind: 'text', restart: true },
      { key: 'GEOIP_DB', label: 'Location database', help: 'Path to the MaxMind file deploy/geoip-update.sh installs.', kind: 'text' },
      { key: 'MAX_CONCURRENT_RUNS', label: 'Runs at once', help: 'Each run drives a Chrome: about half a CPU core and 1.2 GB. Empty follows the machine (3 on 2 cores and 8 GB). Set by pm2 on a hosted install.', kind: 'number', restart: true },
    ],
  },
  {
    key: 'locked',
    title: 'Sign-in and database',
    note: 'Shown for reference. A wrong value here locks you out of this dashboard, so these are changed on the server.',
    keys: [
      { key: 'APP_BASE_URL', label: 'Public URL', help: '', kind: 'url' },
      { key: 'DATABASE_URL', label: 'Database', help: '', kind: 'secret' },
      { key: 'GOOGLE_CLIENT_ID', label: 'Google client ID', help: '', kind: 'text' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Google client secret', help: '', kind: 'secret' },
      { key: 'OAUTH_REDIRECT_URI', label: 'OAuth redirect', help: '', kind: 'url' },
      { key: 'SITE_AUTH_SECRET', label: 'Session secret', help: '', kind: 'secret' },
      { key: 'ADMIN_EMAILS', label: 'Admins', help: '', kind: 'text' },
    ],
  },
];

/** Prefixes that identify a key's kind. Only these are ever sent back for a secret. */
const KNOWN_PREFIX = /^(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|pk_live_|pk_test_|re_|AIza|postgres(?:ql)?:\/\/)/;

const KNOWN = new Map<string, Spec>();
for (const group of GROUPS) for (const spec of group.keys) KNOWN.set(spec.key, spec);

/** A name that looks like it holds a credential is treated as one even when the catalogue has never heard of it. */
const SECRET_NAME = /(SECRET|API_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE|_URL$)/;
function looksSecret(key: string): boolean {
  // A URL is only sensitive when it embeds credentials, as DATABASE_URL does.
  if (key.endsWith('_URL')) return key === 'DATABASE_URL';
  return SECRET_NAME.test(key);
}

export interface EnvEntry {
  key: string;
  label: string;
  help: string;
  kind: Kind;
  /** Plain values only; a secret is never sent, only whether it is set. */
  value: string | null;
  set: boolean;
  length: number;
  /**
   * The recognisable prefix of a secret — sk_live_, whsec_ — and nothing
   * more. It says which kind of key is there (live or test) without saying
   * anything an attacker could use.
   */
  hint: string | null;
  locked: string | null;
  /** Carried by the server process itself, so a file write would be ignored. */
  shadowed: boolean;
  restart: boolean;
  known: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface GroupBanner {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

export interface EnvReport {
  groups: Array<{ key: string; title: string; note?: string; banner?: GroupBanner; entries: EnvEntry[] }>;
  hidden: number;
  restartPending: boolean;
  file: string;
}

/** Set once a boot-time key changes; cleared by the restart it asks for. */
let restartPending = false;

function entryFor(key: string, spec: Spec | undefined, env: Record<string, string>): EnvEntry {
  const kind: Kind = spec?.kind ?? (looksSecret(key) ? 'secret' : 'text');
  const raw = env[key] ?? '';
  return {
    key,
    label: spec?.label ?? key,
    help: spec?.help ?? '',
    kind,
    value: kind === 'secret' ? null : raw,
    set: raw.length > 0,
    length: raw.length,
    hint: kind === 'secret' ? (raw.match(KNOWN_PREFIX)?.[0] ?? null) : null,
    locked: LOCKED[key] ?? null,
    shadowed: process.env[key] !== undefined,
    restart: spec?.restart ?? false,
    known: spec !== undefined,
    options: spec?.options,
  };
}

/** What the payments group says across its top, from the same check checkout itself runs. */
function paymentsBanner(): GroupBanner {
  const state = paymentsState();
  if (!state.configured) return { tone: 'bad', text: `Checkout is off. ${state.problem}` };
  if (state.mode === 'test') return { tone: 'warn', text: 'TEST mode. Only Stripe test cards work; a real customer cannot pay.' };
  return { tone: 'ok', text: 'LIVE mode. Real cards are charged.' };
}

/** A hosted endpoint without its key fails every rewrite quietly: letters simply go out un-rewritten. */
function humanizerBanner(env: Record<string, string>): GroupBanner | undefined {
  const url = process.env.HUMANIZER_URL ?? env.HUMANIZER_URL ?? '';
  if (!url.startsWith('https://') || (process.env.HUMANIZER_API_KEY ?? env.HUMANIZER_API_KEY)) return undefined;
  return { tone: 'warn', text: 'The humanizer URL is a hosted API but no API key is set. The Server tab shows whether it is answering.' };
}

/** Catches the one way this group is silently useless: CapMonster chosen, no key to call it with. */
function captchaBanner(env: Record<string, string>): GroupBanner | undefined {
  const solvers = (env.CAPTCHA_SOLVER ?? '').split(',').map((name) => name.trim());
  if (!solvers.includes('capmonster')) return undefined;
  return (process.env.CAPMONSTER_API_KEY ?? env.CAPMONSTER_API_KEY)
    ? { tone: 'ok', text: 'CapMonster is on. Each solve is billed to your CapMonster balance.' }
    : { tone: 'bad', text: 'CapMonster is selected but has no API key, so it solves nothing.' };
}

export function envReport(): EnvReport {
  const env = readEnv();
  const groups: EnvReport['groups'] = GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    note: group.note,
    banner: group.banner?.(env),
    entries: group.keys.map((spec) => entryFor(spec.key, spec, env)),
  }));

  // Anything in the file the catalogue does not describe still has to be reachable.
  const other = Object.keys(env)
    .filter((key) => !KNOWN.has(key) && !PER_ACCOUNT.has(key))
    .sort()
    .map((key) => entryFor(key, undefined, env));
  if (other.length) groups.push({ key: 'other', title: 'Other', note: 'In the file but not described here.', entries: other });

  const hidden = Object.keys(env).filter((key) => PER_ACCOUNT.has(key)).length;
  return { groups, hidden, restartPending, file: resolve(BOT_DIR, '.env') };
}

// ---------------------------------------------------------------- writing

const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Returns the value to store, or throws with a message the operator can act on. */
function normalise(key: string, spec: Spec | undefined, raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(`${key}: expected text.`);
  if (/[\r\n]/.test(raw)) throw new Error(`${key}: a value cannot contain a line break.`);
  const value = raw.trim();
  const kind = spec?.kind ?? (looksSecret(key) ? 'secret' : 'text');
  if (!value) return '';
  switch (kind) {
    case 'number':
      if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`${key}: must be a number.`);
      return value;
    case 'boolean':
      if (value !== 'true' && value !== 'false') throw new Error(`${key}: must be true or false.`);
      return value;
    case 'url':
      if (!/^https?:\/\/\S+$/.test(value)) throw new Error(`${key}: must start with http:// or https://.`);
      return value.replace(/\/+$/, '');
    case 'choice':
      if (!spec?.options?.some((option) => option.value === value)) {
        throw new Error(`${key}: must be one of ${(spec?.options ?? []).map((option) => option.value).join(', ')}.`);
      }
      return value;
    default:
      return value;
  }
}

export interface EnvChangeResult {
  changed: string[];
  restartNeeded: boolean;
}

/**
 * Applies a set of changes to the file.
 *
 * Every change is checked before any is written, so a bad value in one field
 * leaves the whole form unsaved rather than half of it. The previous file is
 * kept beside the new one: a single .env.bak, overwritten each time, which
 * is enough to undo the last save by hand.
 */
export function applyEnvChanges(changes: Record<string, unknown>, actor: string): EnvChangeResult {
  const updates: Record<string, string> = {};
  for (const [key, raw] of Object.entries(changes)) {
    if (!KEY_NAME.test(key)) throw new Error(`"${key}" is not a valid setting name.`);
    if (LOCKED[key]) throw new Error(`${key}: ${LOCKED[key]}`);
    if (PER_ACCOUNT.has(key)) throw new Error(`${key} is set per account, not here.`);
    if (process.env[key] !== undefined) {
      throw new Error(`${key} is set in the server process (ecosystem.config.cjs), so a change here would be ignored.`);
    }
    updates[key] = normalise(key, KNOWN.get(key), raw);
  }

  const current = readEnv();
  const changed = Object.keys(updates).filter((key) => (current[key] ?? '') !== updates[key]);
  if (changed.length === 0) return { changed: [], restartNeeded: restartPending };

  const path = resolve(BOT_DIR, '.env');
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const toWrite: Record<string, string> = {};
  for (const key of changed) toWrite[key] = updates[key];
  writeEnv(toWrite);

  // Read back rather than trust: the file is the truth, not the request.
  const after = readEnv();
  const failed = changed.filter((key) => (after[key] ?? '') !== updates[key]);
  if (failed.length) throw new Error(`The file did not take the change for ${failed.join(', ')}.`);

  if (changed.some((key) => KNOWN.get(key)?.restart)) restartPending = true;
  // Names only: the console must never carry a value.
  console.log(`[config] ${actor} changed ${changed.join(', ')}`);
  return { changed, restartNeeded: restartPending };
}

// ---------------------------------------------------------------- restart

/**
 * Restarts the dashboard by exiting; pm2 brings it back within a couple of
 * seconds. Refused while any run is going, because a run's Chrome is a
 * child of this process and would die mid-application.
 */
export function restartDashboard(actor: string): { ok: true } | { ok: false; error: string } {
  if (deploying()) return { ok: false, error: 'An update is installing; it restarts the dashboard itself.' };
  if (runner.anyRunning()) return { ok: false, error: 'A run is in progress. Restart once it finishes, or stop it first.' };
  if (process.env.pm_id === undefined) {
    return { ok: false, error: 'Not running under pm2, so nothing would bring the dashboard back. Restart it by hand.' };
  }
  console.log(`[config] ${actor} restarted the dashboard`);
  // Let the reply reach the browser first.
  setTimeout(() => {
    try {
      stopAllSignins();
    } finally {
      process.exit(0);
    }
  }, 400).unref();
  return { ok: true };
}
