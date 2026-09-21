export const FREE_APPLICATIONS = 5;

/** Humanizer is a meaningful paid upgrade, not a safety feature. */
export const HUMANIZER_NOTE = 'Humanizer is included with Active Search and Intensive Pass.';

/** One-off, non-renewing products. Prices include GST where it applies. */
export const PAID_PLANS = {
  'essential-pass': {
    key: 'essential-pass', kind: 'pass', name: 'Essential Pass', priceCents: 990,
    applications: 50, durationDays: 30, employerSiteApplications: 0,
    description: 'Affordable automatic applications for a focused SEEK search.',
  },
  'job-search-pass': {
    key: 'job-search-pass', kind: 'pass', name: 'Active Search', priceCents: 2490,
    applications: 200, durationDays: 60, employerSiteApplications: 0,
    description: 'A broader automatic search across SEEK and Indeed.',
  },
  'intensive-pass': {
    key: 'intensive-pass', kind: 'pass', name: 'Intensive Pass', priceCents: 5990,
    applications: 400, durationDays: 90, employerSiteApplications: 30,
    description: 'Maximum capacity, advanced controls and complex employer-site applications.',
  },
  'application-top-up': {
    key: 'application-top-up', kind: 'application-top-up', name: 'Application Top-up', priceCents: 690,
    applications: 50, durationDays: 0, employerSiteApplications: 0,
    description: 'Extra successful applications on an active paid pass.',
  },
} as const;

export const PASS_PLAN_KEYS = ['essential-pass', 'job-search-pass', 'intensive-pass'] as const;
export type PassPlanKey = typeof PASS_PLAN_KEYS[number];

export const PLAN_LIMITS = {
  free: { autoRunsPerDay: 1, evaluationsPerRun: 5 },
  'essential-pass': { autoRunsPerDay: 1, evaluationsPerRun: 25 },
  'job-search-pass': { autoRunsPerDay: 4, evaluationsPerRun: 70 },
  'intensive-pass': { autoRunsPerDay: 4, evaluationsPerRun: 80, employerSitesPerDay: 5 },
} as const;

export const SCHEDULED_MIN_SCORE = 75;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const FREE = PLAN_LIMITS.free;
const ESSENTIAL = PLAN_LIMITS['essential-pass'];
const ACTIVE = PLAN_LIMITS['job-search-pass'];
const INTENSIVE = PLAN_LIMITS['intensive-pass'];

export const PLAN_PRESENTATION = {
  free: {
    label: 'Try it free',
    description: 'See Owtomate apply to well-matched SEEK roles before paying.',
    features: [
      `${FREE_APPLICATIONS} successful applications`,
      `${plural(FREE.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${FREE.evaluationsPerRun} jobs each run`,
      `${SCHEDULED_MIN_SCORE}% minimum match for scheduled applications`,
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'essential-pass': {
    label: 'Affordable essentials',
    description: PAID_PLANS['essential-pass'].description,
    features: [
      `${PAID_PLANS['essential-pass'].applications} successful applications`,
      `${PAID_PLANS['essential-pass'].durationDays} days of automatic searching`,
      `${plural(ESSENTIAL.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${ESSENTIAL.evaluationsPerRun} jobs each run`,
      `${SCHEDULED_MIN_SCORE}% minimum match`,
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Broader search',
    description: PAID_PLANS['job-search-pass'].description,
    features: [
      `${PAID_PLANS['job-search-pass'].applications} successful applications`,
      `${PAID_PLANS['job-search-pass'].durationDays} days of automatic searching`,
      `Up to ${plural(ACTIVE.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${ACTIVE.evaluationsPerRun} jobs each run`,
      'SEEK and Indeed applications',
      'Advanced match and listing-age filters',
      'Priority processing',
      'Humanizer rewrites cover letters in natural words',
    ],
  },
  'intensive-pass': {
    label: 'Maximum control',
    description: PAID_PLANS['intensive-pass'].description,
    features: [
      `${PAID_PLANS['intensive-pass'].applications} successful applications`,
      `${PAID_PLANS['intensive-pass'].durationDays} days of automatic searching`,
      `Up to ${plural(INTENSIVE.autoRunsPerDay, 'automatic live run', 'automatic live runs')} each day`,
      `AI reviews up to ${INTENSIVE.evaluationsPerRun} jobs each run`,
      'SEEK and Indeed applications',
      'Advanced search controls and standing instructions',
      `${PAID_PLANS['intensive-pass'].employerSiteApplications} employer-site applications included`,
      'Priority processing and support',
      'Humanizer rewrites cover letters in natural words',
    ],
  },
} as const;

export type PaidPlanKey = keyof typeof PAID_PLANS;

export function isPaidPlanKey(value: unknown): value is PaidPlanKey {
  return typeof value === 'string' && value in PAID_PLANS;
}

export function isPassPlanKey(value: unknown): value is PassPlanKey {
  return typeof value === 'string' && (PASS_PLAN_KEYS as readonly string[]).includes(value);
}

export function aud(cents: number): string {
  return `A$${(cents / 100).toFixed(2)}`;
}
