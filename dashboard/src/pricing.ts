export const FREE_MONTHLY_APPLICATIONS = 10;
export const FREE_MONTHLY_REHEARSALS = 30;

export const PLAN_PRESENTATION = {
  free: {
    label: 'Automatic essentials',
    description: 'A simple way to let Myasis apply for well-matched SEEK roles.',
    features: [
      '10 successful applications each month',
      'Up to 4 automatic live runs each day',
      '75% minimum match for scheduled applications',
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'job-search-pass': {
    label: 'Automatic job search',
    description: 'More application capacity while Myasis runs your search for you.',
    features: [
      '150 successful applications for 30 days',
      'Up to 4 automatic live runs each day',
      '75% minimum match for scheduled applications',
      'SEEK applications',
      'Personalised cover letters and application tracking',
    ],
  },
  'intensive-pass': {
    label: 'You control each run',
    description: 'More control, more capacity and support for employer application sites.',
    features: [
      '320 successful applications for 30 days',
      'Up to 3 user-started runs each day',
      'Choose a live run or a rehearsal',
      'Advanced search controls and standing instructions',
      'Supported employer-site applications',
    ],
  },
} as const;

export const PAID_PLANS = {
  'job-search-pass': {
    key: 'job-search-pass',
    name: 'Job Search Pass',
    priceCents: 599,
    applications: 150,
    validDays: 30,
    description: 'A focused month of applications for an active job search.',
  },
  'intensive-pass': {
    key: 'intensive-pass',
    name: 'Intensive Pass',
    priceCents: 1299,
    applications: 320,
    validDays: 30,
    description: 'More application capacity for a broad or urgent search.',
  },
  'application-top-up': {
    key: 'application-top-up',
    name: 'Application Top-up',
    priceCents: 299,
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
