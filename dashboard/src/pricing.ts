import { USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';
import {SEEK_CONNECTION_APPLICATIONS} from './free-trial.js';

export const FREE_APPLICATIONS = 5;
const DAILY_APPLICATION_MAX = USER_RUN_LIMITS.MAX_APPS_PER_DAY;

/** One-off, non-renewing products. Prices include GST where it applies. */
export const PAID_PLANS = {
  'essential-pass': {
    key: 'essential-pass', kind: 'pass', name: 'Essential Pass', priceCents: 1900,
    applications: 50, durationDays: 30, employerSiteApplications: 10,
    description: 'A focused job search with automatic applications.',
  },
  'job-search-pass': {
    key: 'job-search-pass', kind: 'pass', name: 'Active Search', priceCents: 3499,
    applications: 200, durationDays: 30, employerSiteApplications: 20,
    description: 'A broader automatic search across SEEK, Indeed and Jora.',
  },
  // The general ledger retains units for upgrade and receipt history. No finite employer-site grant is needed.
  'intensive-pass': {
    key: 'intensive-pass', kind: 'pass', name: 'Get Owtomated', priceCents: 9950,
    applications: 400, durationDays: 30, employerSiteApplications: 0, unlimitedApplications: true,
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
  free: { autoRunsPerDay: 1, evaluationsPerRun: 30 },
  'essential-pass': { autoRunsPerDay: 2, evaluationsPerRun: 25 },
  'job-search-pass': { autoRunsPerDay: 3, evaluationsPerRun: 70, applicationsPerDay: 50 },
  'intensive-pass': { autoRunsPerDay: 3, evaluationsPerRun: 200 },
} as const;

/** Highest active pass wins; the global admin/Intensive ceiling remains 100. */
export function planDailyApplicationLimit(paid:{hasActiveJobSearchPass?:boolean;hasActiveIntensivePass?:boolean},admin=false):number {
  return !admin && !paid.hasActiveIntensivePass && paid.hasActiveJobSearchPass
    ? PLAN_LIMITS['job-search-pass'].applicationsPerDay : DAILY_APPLICATION_MAX;
}

export function joraConnectionAllowed(paid: { hasActivePass: boolean }, admin = false): boolean {
  return admin || paid.hasActivePass;
}

export const SCHEDULED_MIN_SCORE = 60;
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
    description: 'Start without connecting a job board. No card needed.',
    features: [
      `${FREE_APPLICATIONS} free employer-site applications`,
      `Connect SEEK for ${SEEK_CONNECTION_APPLICATIONS} extra free applications (${FREE_APPLICATIONS+SEEK_CONNECTION_APPLICATIONS} total)`,
      `${plural(FREE.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${FREE.evaluationsPerRun} jobs each run`,
      `Jobs that match your resume by at least ${SCHEDULED_MIN_SCORE}%`,
      'Only employer forms that do not require an account',
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
      `${PAID_PLANS['essential-pass'].employerSiteApplications} employer-site applications (guest forms only)`,
      'SEEK, Indeed and Jora applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Broader search',
    description: PAID_PLANS['job-search-pass'].description,
    features: [
      `${PAID_PLANS['job-search-pass'].applications} application credits`,
      `Daily limit: ${ACTIVE.applicationsPerDay} applications`,
      `${PAID_PLANS['job-search-pass'].durationDays} days of access`,
      `Up to ${plural(ACTIVE.autoRunsPerDay, 'scheduled run', 'scheduled runs')} each day · Auto apply or Semi auto`,
      `AI reviews up to ${ACTIVE.evaluationsPerRun} jobs each run`,
      `Choose your minimum match score: ${CUSTOM_MIN_SCORE}% to ${MAX_MATCH_SCORE}%`,
      `${PAID_PLANS['job-search-pass'].employerSiteApplications} employer-site applications (guest forms only)`,
      'SEEK, Indeed and Jora applications',
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
      'SEEK, Indeed and Jora applications',
      'Advanced match and listing-age filters',
      'No separate employer-site limit',
      'Account creation with connected Gmail',
      'SmartRecruiters, Greenhouse, PageUp and Workday job sources',
      'Web search for employer-site jobs',
      'Priority support',
    ],
  },
} as const;

const PLAN_FEATURE_HELP = [
  [/^\d+ free employer-site applications$/, 'Use these to apply on employer websites with guest forms.'],
  [/^Connect SEEK for \d+ extra free applications/, 'Get extra application credits when you connect your SEEK account.'],
  [/scheduled runs? each day/, 'With scheduling on, Owtomate starts this many runs automatically each day.'],
  [/^AI reviews up to \d+ jobs each run$/, 'How many job listings Owtomate can check for fit in one run.'],
  [/^Jobs that match your resume by at least /, 'A job needs this match score before Owtomate can apply or prepare it.'],
  [/^Only employer forms that do not require an account$/, 'Owtomate uses guest forms you can submit without signing in.'],
  [/^\d+(?: additional)? application credits$/, 'One credit covers an application submitted for you or prepared for your review.'],
  [/^Daily limit: \d+ applications$/, 'The most applications Owtomate can submit in one day.'],
  [/^Choose your minimum match score:/, 'Choose the lowest match score a job needs to be considered for application.'],
  [/^\d+(?: extra)? employer-site applications? \(guest forms only\)$/, 'You can use this many of your credits on employer forms that don’t require an account.'],
  [/^Advanced match and listing-age filters$/, 'Choose how closely jobs should match and how recently they were posted.'],
  [/^Unlimited applications$/, 'Use your daily application allowance throughout the pass with no total credit cap.'],
  [/^No separate employer-site limit$/, 'Applications on employer websites count towards the daily application limit.'],
  [/^Account creation with connected Gmail$/, 'Owtomate can create an employer account using your connected Gmail for verification.'],
  [/^Web search for employer-site jobs$/, 'Owtomate searches the web for vacancies on employer careers pages.'],
  [/^Priority support$/, 'Support requests from this plan are prioritised.'],
  [/^Email employers$/, 'After your run, Owtomate can send an introduction from your Gmail for submitted applications when a public hiring contact is available.'],
] as const;

export const planFeatureHelp = (feature: string): string | undefined =>
  PLAN_FEATURE_HELP.find(([label]) => label.test(feature))?.[1];

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
