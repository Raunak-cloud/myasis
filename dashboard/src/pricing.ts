import { USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';

export const FREE_APPLICATIONS = 5;
export const DAILY_APPLICATION_MAX = USER_RUN_LIMITS.MAX_APPS_PER_DAY;

/** One-off, non-renewing products. Prices include GST where it applies. */
export const PAID_PLANS = {
  'essential-pass': {
    key: 'essential-pass', kind: 'pass', name: 'Essential Pass', priceCents: 990,
    applications: 50, durationDays: 30, employerSiteApplications: 0,
    description: 'Affordable automatic applications for a focused SEEK search.',
  },
  'job-search-pass': {
    key: 'job-search-pass', kind: 'pass', name: 'Active Search', priceCents: 1999,
    applications: 200, durationDays: 30, employerSiteApplications: 0,
    description: 'A broader automatic search across SEEK and Indeed.',
  },
  // Legacy ledger units remain for historical purchases. unlimitedApplications controls usage.
  'intensive-pass': {
    key: 'intensive-pass', kind: 'pass', name: 'Get Owtomated', priceCents: 5999,
    applications: 400, durationDays: 30, employerSiteApplications: 30, unlimitedApplications: true,
    description: 'Unlimited application credits for 30 days, up to 100 applications per day.',
  },
  'application-top-up': {
    key: 'application-top-up', kind: 'application-top-up', name: 'Application Top-up', priceCents: 690,
    applications: 50, durationDays: 0, employerSiteApplications: 0,
    description: 'Extra application credits on an active paid pass.',
  },
} as const;

export const PASS_PLAN_KEYS = ['essential-pass', 'job-search-pass', 'intensive-pass'] as const;
export type PassPlanKey = typeof PASS_PLAN_KEYS[number];

export const PLAN_LIMITS = {
  free: { autoRunsPerDay: 1, evaluationsPerRun: 15 },
  'essential-pass': { autoRunsPerDay: 2, evaluationsPerRun: 25 },
  'job-search-pass': { autoRunsPerDay: 4, evaluationsPerRun: 70 },
  'intensive-pass': { autoRunsPerDay: 4, evaluationsPerRun: 80, employerSitesPerDay: 5 },
} as const;

export const SCHEDULED_MIN_SCORE = 75;
export const CUSTOM_MIN_SCORE = 60;
export const MAX_MATCH_SCORE = 100;

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
      `${FREE_APPLICATIONS} application credits`,
      `${plural(FREE.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${FREE.evaluationsPerRun} jobs each run`,
      `Jobs that match your resume by at least ${SCHEDULED_MIN_SCORE}%`,
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'essential-pass': {
    label: 'Affordable essentials',
    description: PAID_PLANS['essential-pass'].description,
    features: [
      `${PAID_PLANS['essential-pass'].applications} application credits`,
      `${PAID_PLANS['essential-pass'].durationDays} days of access`,
      `${plural(ESSENTIAL.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${ESSENTIAL.evaluationsPerRun} jobs each run`,
      `Jobs that match your resume by at least ${SCHEDULED_MIN_SCORE}%`,
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Broader search',
    description: PAID_PLANS['job-search-pass'].description,
    features: [
      `${PAID_PLANS['job-search-pass'].applications} application credits`,
      `${PAID_PLANS['job-search-pass'].durationDays} days of access`,
      `Up to ${plural(ACTIVE.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${ACTIVE.evaluationsPerRun} jobs each run`,
      `Choose your minimum match score: ${CUSTOM_MIN_SCORE}% to ${MAX_MATCH_SCORE}%`,
      'SEEK and Indeed applications',
      'Advanced match and listing-age filters',
    ],
  },
  'intensive-pass': {
    label: 'Unlimited applications',
    description: PAID_PLANS['intensive-pass'].description,
    features: [
      'Unlimited applications',
      `Daily limit: ${DAILY_APPLICATION_MAX} applications`,
      `${PAID_PLANS['intensive-pass'].durationDays} days of access`,
      `Up to ${plural(INTENSIVE.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${INTENSIVE.evaluationsPerRun} jobs each run`,
      `Choose your minimum match score: ${CUSTOM_MIN_SCORE}% to ${MAX_MATCH_SCORE}%`,
      'SEEK and Indeed applications',
      'Advanced search controls and standing instructions',
      'Supported employer-site applications',
      'Priority support',
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
