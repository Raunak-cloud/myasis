export const FREE_MONTHLY_APPLICATIONS = 5;

/** Humanizer rewrites cover letters in natural words; it comes with a paid pass. */
export const HUMANIZER_NOTE = 'Humanizer is only available with Job Search Pass and Intensive Pass.';

export const PLAN_PRESENTATION = {
  free: {
    label: 'Automatic essentials',
    description: 'A simple way to let Myasis apply for well-matched SEEK roles.',
    features: [
      `${FREE_MONTHLY_APPLICATIONS} successful applications each month`,
      '1 automatic live run each day',
      'AI reviews 10 jobs each run',
      '75% minimum match for scheduled applications',
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Automatic job search',
    description: 'More application capacity while Myasis runs your search for you.',
    features: [
      '150 successful applications',
      'Up to 4 automatic live runs each day',
      'AI reviews 70 jobs each run',
      '75% minimum match for scheduled applications',
      'SEEK and Indeed applications',
      'Personalised cover letters and application tracking',
      'Humanizer rewrites every cover letter in natural words',
    ],
  },
  'intensive-pass': {
    label: 'You control each run',
    description: 'More control, more capacity and support for employer application sites.',
    features: [
      '320 successful applications',
      'Up to 3 user-started runs each day',
      'AI reviews 100 jobs each run',
      'SEEK and Indeed applications',
      'Advanced search controls and standing instructions',
      'Supported employer-site applications',
      'Humanizer rewrites every cover letter in natural words',
    ],
  },
} as const;

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

export type PaidPlanKey = keyof typeof PAID_PLANS;

export function isPaidPlanKey(value: unknown): value is PaidPlanKey {
  return typeof value === 'string' && value in PAID_PLANS;
}

export function aud(cents: number): string {
  return `A$${(cents / 100).toFixed(2)}`;
}
