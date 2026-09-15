export const FREE_MONTHLY_APPLICATIONS = 5;

/** Humanizer rewrites cover letters in natural words; it comes with a paid pass. */
export const HUMANIZER_NOTE = 'Humanizer is only available with Job Search Pass and Intensive Pass.';


/**
 * Prices cover a pass used in full, at the model prices due in 2027.
 *
 * Measured in production in September 2026: job search and fit checks cost
 * about US$0.027 per run; the browser agent about US$0.006 per attempt, with
 * about 2.5 attempts per successful application; a cover letter about
 * US$0.009 on Gemini Flash, doubling on 1 January 2027, and written only when
 * a form has a cover-letter box. Each price is checked against its worst
 * case — every run of the pass used, every application submitted, and for
 * Intensive every employer-site slot — after card fees and GST, with room
 * left over. Change the allowances or runs here and that check has to be
 * done again.
 */
export const PAID_PLANS = {
  'job-search-pass': {
    key: 'job-search-pass',
    name: 'Job Search Pass',
    priceCents: 1999,
    applications: 150,
    validDays: 30,
    description: 'A focused month of applications for an active job search.',
  },
  'intensive-pass': {
    key: 'intensive-pass',
    name: 'Intensive Pass',
    priceCents: 3999,
    applications: 320,
    validDays: 30,
    description: 'More application capacity for a broad or urgent search.',
  },
  'application-top-up': {
    key: 'application-top-up',
    name: 'Application Top-up',
    priceCents: 499,
    applications: 50,
    validDays: 30,
    description: 'Extra successful applications without changing your plan.',
  },
} as const;

/**
 * What each plan allows.
 *
 * Enforced by server/entitlements.ts and server/start-run.ts, and the plan
 * features below are written from these same numbers, so what a plan says
 * and what a run does cannot drift apart. Change a number here and both move.
 */
export const PLAN_LIMITS = {
  free: { autoRunsPerDay: 1, evaluationsPerRun: 5 },
  'job-search-pass': { autoRunsPerDay: 4, evaluationsPerRun: 70 },
  'intensive-pass': { manualRunsPerDay: 3, evaluationsPerRun: 100, employerSitesPerDay: 5 },
} as const;

/** Scheduled applications must clear this model-assessed match threshold. */
export const SCHEDULED_MIN_SCORE = 75;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const FREE = PLAN_LIMITS.free;
const JOB_SEARCH = PLAN_LIMITS['job-search-pass'];
const INTENSIVE = PLAN_LIMITS['intensive-pass'];

export const PLAN_PRESENTATION = {
  free: {
    label: 'Automatic essentials',
    description: 'A simple way to let Owtomate apply for well-matched SEEK roles.',
    features: [
      `${FREE_MONTHLY_APPLICATIONS} successful applications`,
      `${plural(FREE.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${FREE.evaluationsPerRun} jobs each run`,
      `${SCHEDULED_MIN_SCORE}% minimum match for scheduled applications`,
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Automatic job search',
    description: 'More application capacity while Owtomate runs your search for you.',
    features: [
      `${PAID_PLANS['job-search-pass'].applications} successful applications`,
      `Up to ${plural(JOB_SEARCH.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${JOB_SEARCH.evaluationsPerRun} jobs each run`,
      `${SCHEDULED_MIN_SCORE}% minimum match for scheduled applications`,
      'SEEK and Indeed applications',
      'Personalised cover letters and application tracking',
      'Humanizer rewrites cover letters in natural words',
    ],
  },
  'intensive-pass': {
    label: 'You control each run',
    description: 'More control, more capacity and support for employer application sites.',
    features: [
      `${PAID_PLANS['intensive-pass'].applications} successful applications`,
      `Up to ${plural(INTENSIVE.manualRunsPerDay, 'user-started run', 'user-started runs')} each day`,
      `AI reviews up to ${INTENSIVE.evaluationsPerRun} jobs each run`,
      'SEEK and Indeed applications',
      'Advanced search controls and standing instructions',
      `Employer-site applications, up to ${INTENSIVE.employerSitesPerDay} a day`,
      'Humanizer rewrites cover letters in natural words',
    ],
  },
} as const;

export type PaidPlanKey = keyof typeof PAID_PLANS;

export function isPaidPlanKey(value: unknown): value is PaidPlanKey {
  return typeof value === 'string' && value in PAID_PLANS;
}

export function aud(cents: number): string {
  return `A$${(cents / 100).toFixed(2)}`;
}
