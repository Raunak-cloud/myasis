import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { CandidateProfile } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(ROOT, '.env') });

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
    experienceSummary:
      process.env.EXPERIENCE_SUMMARY ??
      '~2 years freelance full-stack development and ~2 years freelance AI & Automation Engineer work. ACS member. Projects: DanpheAi, Nasosend, Gharsuchi, Tohmeal.',
    skills: (process.env.SKILLS ?? 'JavaScript,TypeScript,React,React Native,Node.js,Firebase,MongoDB,Next.js,Python,HTML5,Sass,Expo')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    excludedDomains: (
      process.env.EXCLUDED_DOMAINS ??
      '.NET/C# as core stack,blockchain,crypto,mainframe,COBOL,IAM/identity security as core stack,Golang as core stack,PHP/Laravel as core stack,Ruby on Rails as core stack,Java/Spring as core stack'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

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
    process.env.KEYWORDS ??
    // Spans the whole resume: full-stack, React/frontend, Node/backend,
    // React Native/mobile, Firebase, the AI & automation half, and the
    // early-career title variants.
    'full stack developer,full stack engineer,full stack javascript,web developer,' +
      'react developer,frontend developer react,frontend engineer,next.js developer,' +
      'node.js developer,backend developer node,javascript engineer,typescript developer,' +
      'react native developer,mobile developer react native,firebase developer,' +
      'ai engineer,ai engineer python,ai automation engineer,llm engineer,python developer,' +
      'junior software engineer,graduate software engineer'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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
   * Deliberately conservative. SEEK Pass verification walls and Indeed
   * reCAPTCHA both appeared after ~44 applications in one day, so these
   * defaults stay well under that and back off hard on any friction signal.
   */
  limits: {
    maxApplicationsPerRun: Number(process.env.MAX_APPS_PER_RUN ?? 8),
    /** Detail pages opened per run — bounds both wall-clock and model spend. */
    // Keep an accidentally large dashboard value from creating an hour-long crawl.
    maxEvaluations: Math.max(1, Math.min(120, Number(process.env.MAX_EVALUATIONS ?? 40))),
    /**
     * Result pages to read per keyword. SEEK returns 32 per page, so page 1
     * alone caps discovery at 32 × keywords — and once the obvious listings are
     * applied to, everything left worth having is on pages 2+.
     */
    pagesPerKeyword: Number(process.env.PAGES_PER_KEYWORD ?? 1),
    maxApplicationsPerDay: Number(process.env.MAX_APPS_PER_DAY ?? 20),
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

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
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
