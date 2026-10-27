import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { CandidateProfile } from './types.js';
import { applicationModelEnvironment } from './application-model.js';
import { USER_RUN_LIMITS, boundedUserRunLimit, dailyApplicationLimit } from './run-limits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env') });

/** True for a run started by an operator of this installation. Set only by the dashboard. */
const adminUnlimited = process.env.ADMIN_UNLIMITED === 'true';

/**
 * A configured value, floored at 1 and capped at `max` — except for an
 * admin's run, where the cap is lifted and only the floor remains.
 */
function ceiling(max: number, value: string | undefined, fallback: number, applicationLimit = false): number {
  const unlimited = adminUnlimited || applicationLimit && process.env.APPLICATIONS_UNLIMITED === 'true';
  // Only trusted operator or paid application entitlements may lift the relevant cap.
  if (value?.trim().toLowerCase() === 'none') return unlimited ? Infinity : fallback;
  const wanted = Number(value ?? fallback);
  if (!Number.isFinite(wanted)) return fallback;
  return Math.max(1, unlimited ? Math.floor(wanted) : Math.min(max, wanted));
}

function decodeBase64(value?: string): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Operator-approved answer when the candidate has left expected salary blank. */
export function expectedSalaryAnswer(value?: string): string {
  return value?.trim() || 'Negotiable';
}

/**
 * Parses the existing `profile.txt` (key : value per line) so the bot and any
 * manual workflow share one source of truth. Lines starting with `---` are
 * section headers and ignored.
 */
export function loadProfile(path = process.env.PROFILE_PATH ?? resolve(ROOT, '..', 'profile.txt')): CandidateProfile {
  if (!existsSync(path)) throw new Error(`profile.txt not found at ${path}. Set PROFILE_PATH in .env`);
  const raw = readFileSync(path, 'utf8');
  const kv = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (value) kv.set(key, value);
  }

  const find = (...needles: string[]): string | undefined => {
    for (const [k, v] of kv) if (needles.some((n) => k.includes(n))) return v;
    return undefined;
  };

  const relocate = (find('willing to relocate') ?? 'no').toLowerCase();

  return {
    name: find('name') ?? 'Unknown',
    dob: find('date of birth'),
    nationality: find('nationality') ?? 'Not stated',
    workRights: kv.get('australian work rights') ?? kv.get('work rights'),
    workRightsCountry: kv.has('australian work rights') ? 'Australia' : kv.get('work rights country'),
    driving: find('driving'),
    phone: find('phone') ?? '',
    email: find('email') ?? '',
    streetAddress: find('street address'),
    suburb: find('suburb'),
    state: find('state'),
    postcode: find('postcode'),
    linkedin: find('linkedin'),
    github: find('github', 'portfolio'),
    website: find('personal website'),
    qualification: find('highest qualification'),
    expectedSalary: expectedSalaryAnswer(find('expected annual salary')),
    noticePeriod: find('notice period') ?? '2 weeks',
    willingToRelocate: relocate.startsWith('y'),
    willingToTravel: find('willing to travel'),
    pronouns: find('pronouns'),
    gender: find('gender'),
    disability: find('disability'),
    referralSource: find('how did you hear') ?? 'Google',
    securityClearance: process.env.SECURITY_CLEARANCE ?? 'None held',
    experienceSummary: process.env.EXPERIENCE_SUMMARY ?? find('experience summary') ?? '',
    skills: (process.env.SKILLS ?? find('skills') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    excludedDomains: (process.env.EXCLUDED_DOMAINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Search terms honoured per run — see the note on `keywords` below. */
const MAX_SEARCH_TERMS = 3;

export const config = {
  /**
   * Reuses each account's Chrome profile, including its existing sessions.
   */
  userDataDir: process.env.CHROME_PROFILE_DIR ?? 'C:\\Users\\PC\\ChromeDebugProfile',
  chromePath: process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: process.env.HEADLESS === 'true',
  /** Real window, parked off-screen: same fingerprint as visible, out of the way. */
  background: process.env.BACKGROUND === 'true',

  /** Injected by the dashboard only for an active Intensive Pass. */
  allowExternalApply: process.env.ALLOW_EXTERNAL_APPLY === 'true',

  seekBase: process.env.SEEK_BASE ?? 'https://www.seek.com.au',

  /**
   * Narrow the search geographically, using SEEK's own radius filter rather
   * than filtering after the fact.
   *
   * Verified against the live site: `?keywords=…&where=…&distance=N` redirects
   * to the canonical `/{role}-jobs/in-{Location}?distance=N` and genuinely
   * changes the result set. Letting SEEK do this server-side beats scoring
   * distance ourselves — job locations come through as suburb text with no
   * coordinates, so we would have to geocode them to do any better.
   *
   * `location` is filled from the candidate's own address by the dashboard;
   * a zero radius means "no geographic limit", which is the previous
   * behaviour.
   */
  search: {
    location: process.env.SEARCH_LOCATION ?? '',
    radiusKm: Number(process.env.SEARCH_RADIUS_KM ?? 0),
  },
  indeedBase: process.env.INDEED_BASE ?? 'https://au.indeed.com',

  /**
   * Job boards to search. Only boards with an adapter are honoured — see
   * platforms.ts. Defaults to SEEK, the one that is implemented.
   */
  platforms: (process.env.PLATFORMS ?? 'seek')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  keywords: (
    process.env.KEYWORDS ?? ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    /**
     * Capped, because search traffic is the product of terms and pages.
     *
     * Ten terms at five pages is fifty result pages before a single job is
     * opened, and repeated runs at that volume are what triggered a Cloudflare
     * challenge that blocked the account for everything. Three terms keeps a run
     * quiet enough to stay unremarkable, and the terms further down a list are
     * rarely the ones producing applications anyway. Operators included: the
     * limit is about how a run looks to the job board, not about a plan.
     */
    .slice(0, MAX_SEARCH_TERMS),

  /** seek.md rules, as data. */
  rules: {
    maxAgeDays: boundedUserRunLimit('MAX_AGE_DAYS', process.env.MAX_AGE_DAYS, 20),
    minSalary: Number(process.env.MIN_SALARY ?? 70_000),
    minHourlyRate: Number(process.env.MIN_HOURLY_RATE ?? 0),
    minScore: Number(process.env.MIN_SCORE ?? 60),
    onsiteCity: process.env.ONSITE_CITY ?? 'Sydney',

    /**
     * Which work arrangements to accept. Onsite and hybrid are additionally
     * constrained to `onsiteCity`; allowed remote roles may be elsewhere.
     */
    workArrangements: (process.env.WORK_ARRANGEMENTS ?? 'remote,hybrid,onsite')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),

    /** Optional: full time, part time, contract, casual. Empty = any. */
    jobTypes: (process.env.JOB_TYPES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  /**
   * What the candidate is actually targeting this run.
   *
   * The fit check otherwise infers the target from the resume, so a software
   * profile will (correctly) reject a delivery-driver ad. Setting this lets the
   * same tool serve a deliberate career change or a second job track, without
   * weakening the honesty rules — the model still may not invent experience.
   */
  targetRole: process.env.TARGET_ROLE ?? '',

  /** Employers this account never wants to apply to. Matched fuzzily in the pipeline. */
  excludedCompanies: (process.env.EXCLUDED_COMPANIES ?? '')
    .split(/[,;\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50),

  /**
   * Free-text standing instructions the account holder wrote for their own
   * search ("no senior or manager positions", "weekends only").
   *
   * These were stored by the dashboard but read by nothing — not the bot, not
   * the settings allowlist — so an account that asked not to be put forward for
   * manager roles was being put forward for them anyway. They are applied as a
   * veto in the fit check: they can only ever stop an application, never start
   * one, and they never loosen the honesty rules.
   */
  aiInstructions: decodeBase64(process.env.AI_INSTRUCTIONS_B64),

  /**
   * Deliberately conservative. SEEK Pass verification walls and Indeed
   * reCAPTCHA both appeared after ~44 applications in one day, so these
   * defaults stay well under that and back off hard on any friction signal.
   */
  limits: {
    /**
     * Hard ceilings, not just defaults.
     *
     * Every one of these multiplies into site traffic — terms x pages is the
     * search load, evaluations is the job pages opened, applications is the
     * submissions. A run that quietly asked for 10 terms at 5 pages is what
     * earned a Cloudflare challenge that locked the account out entirely, so
     * these are clamped here rather than trusted from a caller.
     *
     * `ADMIN_UNLIMITED` lifts the ceilings, not the defaults: it is set only
     * by the dashboard for an operator of this installation, who is the one
     * person who can judge the traffic risk and is accepting it deliberately.
     */
    maxApplicationsPerRun: ceiling(USER_RUN_LIMITS.MAX_APPS_PER_DAY, process.env.MAX_APPS_PER_RUN, USER_RUN_LIMITS.MAX_APPS_PER_DAY, true),
    /** Detail pages opened per run — bounds both wall-clock and model spend. */
    // Keep an accidentally large dashboard value from creating an hour-long crawl.
    maxEvaluations: ceiling(150, process.env.MAX_EVALUATIONS, 40),
    maxApplicationsPerDay: dailyApplicationLimit(process.env.MAX_APPS_PER_DAY),
    /**
     * Employer-site applications SUBMITTED per day. Unset means no limit (a
     * direct CLI run); "0" means none are allowed, which is what every
     * account without an Intensive Pass gets. They cost
     * 10-20x a SEEK Quick Apply in model calls, so the dashboard sets this
     * from the account's plan (Intensive Pass only) and passes today's
     * submitted count in EXTERNAL_ATTEMPTS_TODAY. A failed attempt still
     * costs model calls, but the run's own step and cost budgets bound that —
     * charging it against the daily allowance would let one bad form lock the
     * candidate out of every employer site for the day.
     */
    maxExternalPerDay: process.env.MAX_EXTERNAL_PER_DAY
      ? Math.max(0, Number(process.env.MAX_EXTERNAL_PER_DAY))
      : Number.POSITIVE_INFINITY,
    externalAttemptsToday: Math.max(0, Number(process.env.EXTERNAL_ATTEMPTS_TODAY ?? 0)),
    minDelayMs: Number(process.env.MIN_DELAY_MS ?? 25_000),
    maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 70_000),
    /** Brief pacing after an attempt that transmitted no application. */
    minNonSubmitDelayMs: Number(process.env.MIN_NON_SUBMIT_DELAY_MS ?? 3_000),
    maxNonSubmitDelayMs: Number(process.env.MAX_NON_SUBMIT_DELAY_MS ?? 8_000),
    searchDelayMs: Number(process.env.SEARCH_DELAY_MS ?? 6_000),
    /** Overlap fit checks with detail-page loading without flooding the model. */
    fitConcurrency: Math.max(1, Math.min(4, Number(process.env.FIT_CONCURRENCY ?? 3))),
    /** Consecutive friction signals (captcha/verification) before aborting the run. */
    frictionAbortThreshold: Number(process.env.FRICTION_ABORT ?? 2),
  },



  /**
   * Celeris drives the browser agent's per-step decisions.
   *
   * Magnus handles navigation and structured reasoning from the first call.
   * Cover-letter drafting retains its separately configured provider.
   */
  celeris: {
    apiKey: process.env.CELERIS_API_KEY ?? '',
    /**
     * Root only. Celeris puts the model id in the URL path ahead of `/v1`, and
     * the path segment must match the body's `model` field, so the per-model
     * endpoint is derived rather than configured.
     */
    baseUrl: process.env.CELERIS_BASE_URL ?? 'https://inference.celeris.ai',
    timeoutMs: Number(process.env.CELERIS_TIMEOUT_MS ?? 45_000),
    /**
     * Sent as max_tokens on every request. Celeris stops a reply at 2,048
     * tokens when none is given, which cut off job rankings and would cut off
     * a reasoning reply. Measured: 8,192 is honoured. Kept moderate because the
     * workspace is rate-limited on output tokens per minute.
     */
    maxOutputTokens: Number(process.env.CELERIS_MAX_OUTPUT_TOKENS ?? 8192),

    /** Resource ceilings; the agent owns form progress and recovery. */
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 60),
    progressMaxSteps: Number(process.env.AGENT_PROGRESS_MAX_STEPS ?? 120),
    maxTotalMs: Number(process.env.AGENT_MAX_MS ?? 1_800_000),
    budgetUsdPerApplication: Number(process.env.AGENT_BUDGET_USD ?? 0.20),
    progressBudgetUsdPerApplication: Number(process.env.AGENT_PROGRESS_BUDGET_USD ?? 0.50),


  },

  coverLetter: {
    /** Tailored is the safe default; reuse sends the user's text verbatim. */
    mode: process.env.COVER_LETTER_MODE === 'reuse' ? 'reuse' as const : 'tailored' as const,
    reusableText: decodeBase64(process.env.COVER_LETTER_TEXT_B64),
  },

  /** Resume selection for a run; set per-run from the dashboard. */
  resume: {
    /** Resume id, label, or filename from data/resumes.json. Empty = SEEK default. */
    select: process.env.RESUME_SELECT ?? '',
    /**
     * Uploading a resume adds it to the account's documents on the job board
     * — a profile change — so a direct command-line run leaves it off. Every
     * run the dashboard starts turns it on (db/run-sync.ts), so the resume
     * chosen for a job is uploaded to SEEK or Indeed when it is not already
     * there, and the Applications tab records that it was.
     */
    allowUpload: process.env.RESUME_ALLOW_UPLOAD === 'true',
  },

  /**
   * Where this run's resumes/knowledge/applied.json/queue.json/run-log.jsonl
   * live. Overridable so the dashboard can point a spawned run at a private
   * per-account directory (`seek-bot/data/users/<id>`) instead of the single
   * shared `data/` folder — same pattern as `PROFILE_PATH` above. Defaults to
   * the original shared path so a direct CLI run (`npm run dev`) is unaffected.
   */
  get dataDir() {
    const directory = applicationModelEnvironment().DATA_DIR;
    return directory ? resolve(directory) : resolve(ROOT, 'data');
  },
  dryRun: process.env.DRY_RUN === 'true',
};
