import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { CandidateProfile } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env') });

/** True for a run started by an operator of this installation. Set only by the dashboard. */
export const adminUnlimited = process.env.ADMIN_UNLIMITED === 'true';

/**
 * A configured value, floored at 1 and capped at `max` — except for an
 * admin's run, where the cap is lifted and only the floor remains.
 */
function ceiling(max: number, value: string | undefined, fallback: number): number {
  const wanted = Number(value ?? fallback);
  if (!Number.isFinite(wanted)) return fallback;
  return Math.max(1, adminUnlimited ? Math.floor(wanted) : Math.min(max, wanted));
}

function decodeBase64(value?: string): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
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
    expectedSalary: find('expected annual salary') ?? 'Negotiable',
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
export const MAX_SEARCH_TERMS = 5;

export const config = {
  /**
   * Reuses the already-authenticated Chrome profile. The bot never handles
   * credentials or automates login — if the session is dead it stops and asks.
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
     * challenge that blocked the account for everything. Five terms keeps a run
     * quiet enough to stay unremarkable, and the terms further down a list are
     * rarely the ones producing applications anyway.
     */
    .slice(0, adminUnlimited ? Infinity : MAX_SEARCH_TERMS),

  /** seek.md rules, as data. */
  rules: {
    maxAgeDays: Number(process.env.MAX_AGE_DAYS ?? 14),
    minSalary: Number(process.env.MIN_SALARY ?? 70_000),
    minHourlyRate: Number(process.env.MIN_HOURLY_RATE ?? 0),
    minScore: Number(process.env.MIN_SCORE ?? 60),
    onsiteCity: process.env.ONSITE_CITY ?? 'Sydney',

    /**
     * Which work arrangements to accept. On-site is additionally constrained to
     * `onsiteCity`; remote and hybrid are accepted anywhere in the country.
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
   * The fit check otherwise infers the target from the résumé, so a software
   * profile will (correctly) reject a delivery-driver ad. Setting this lets the
   * same tool serve a deliberate career change or a second job track, without
   * weakening the honesty rules — the model still may not invent experience.
   */
  targetRole: process.env.TARGET_ROLE ?? '',

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
    maxApplicationsPerRun: ceiling(10, process.env.MAX_APPS_PER_RUN, 8),
    /** Detail pages opened per run — bounds both wall-clock and model spend. */
    // Keep an accidentally large dashboard value from creating an hour-long crawl.
    maxEvaluations: ceiling(150, process.env.MAX_EVALUATIONS, 40),
    /**
     * Result pages to read per keyword. SEEK returns 32 per page, so page 1
     * alone caps discovery at 32 × keywords — and once the obvious listings are
     * applied to, everything left worth having is on pages 2+.
     */
    pagesPerKeyword: ceiling(3, process.env.PAGES_PER_KEYWORD, 1),
    maxApplicationsPerDay: ceiling(50, process.env.MAX_APPS_PER_DAY, 20),
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
    /** Overlap fit checks with detail-page loading without flooding Gemini. */
    fitConcurrency: Math.max(1, Math.min(4, Number(process.env.FIT_CONCURRENCY ?? 3))),
    /** Consecutive friction signals (captcha/verification) before aborting the run. */
    frictionAbortThreshold: Number(process.env.FRICTION_ABORT ?? 2),
  },



  /** Cover letters only — every other model call runs on Celeris. */
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.7-flash',
  },

  /**
   * Celeris drives the browser agent's per-step decisions.
   *
   * `celeris-1` is a low-latency diffusion model built for exactly this shape
   * of call — short, structured, tool-shaped — and `celeris-1-magnus` adds
   * reasoning for the steps it gets stuck on. Cover letters and screening
   * answers deliberately stay on Gemini: those are long-form and grounded
   * against the candidate profile, which is a different job.
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

    /** Ceilings on one application. An agent loop has no natural stopping point. */
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 24),
    /**
     * Stop when the agent is stuck, not merely when it is slow. A slow
     * multi-page employer form that keeps advancing gets as long as it needs.
     */
    maxStuckMs: Number(process.env.AGENT_STUCK_MS ?? 180_000),
    maxTotalMs: Number(process.env.AGENT_MAX_MS ?? 1_800_000),
    budgetUsdPerApplication: Number(process.env.AGENT_BUDGET_USD ?? 0.05),

    /** Turns with no page change before escalating to the reasoning model. */
    escalateAfterStalls: Number(process.env.AGENT_ESCALATE_AFTER ?? 2),

    /** celeris-1 accepts images; a screenshot is attached once a step stalls. */
    useScreenshots: process.env.AGENT_SCREENSHOTS !== 'false',
    /**
     * Trimming the transcript costs cache hits, since Celeris caches on prefix
     * and everything after the system prompt shifts. Kept high enough that a
     * normal application never trims.
     */
    maxTranscriptTokens: Number(process.env.AGENT_MAX_TRANSCRIPT_TOKENS ?? 60_000),
  },

  /** Optional local AuthorMist post-processor served by llama.cpp. */
  humanizer: {
    url: (process.env.HUMANIZER_URL ?? '').replace(/\/$/, ''),
    model: process.env.HUMANIZER_MODEL ?? 'authormist-originality',
    required: process.env.HUMANIZER_REQUIRED === 'true',
    timeoutMs: Number(process.env.HUMANIZER_TIMEOUT_MS ?? 120_000),
  },

  coverLetter: {
    /** Tailored is the safe default; reuse sends the user's text verbatim. */
    mode: process.env.COVER_LETTER_MODE === 'reuse' ? 'reuse' as const : 'tailored' as const,
    reusableText: decodeBase64(process.env.COVER_LETTER_TEXT_B64),
  },

  /** Résumé selection for a run; set per-run from the dashboard. */
  resume: {
    /** Résumé id, label, or filename from data/resumes.json. Empty = SEEK default. */
    select: process.env.RESUME_SELECT ?? '',
    /**
     * Uploading a new résumé adds it to the user's SEEK profile — a profile
     * modification — so it stays off unless explicitly enabled.
     */
    allowUpload: process.env.RESUME_ALLOW_UPLOAD === 'true',
  },

  /**
   * Where this run's résumés/knowledge/applied.json/queue.json/run-log.jsonl
   * live. Overridable so the dashboard can point a spawned run at a private
   * per-account directory (`seek-bot/data/users/<id>`) instead of the single
   * shared `data/` folder — same pattern as `PROFILE_PATH` above. Defaults to
   * the original shared path so a direct CLI run (`npm run dev`) is unaffected.
   */
  dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(ROOT, 'data'),
  dryRun: process.env.DRY_RUN === 'true',
};
