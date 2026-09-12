export const FREE_MONTHLY_APPLICATIONS = 10;
export const FREE_MONTHLY_REHEARSALS = 30;

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
