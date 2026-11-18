import type { BillingStatus } from './billing.js';

/** One pass-wide employer allowance shares the regular application balance. */
export function employerApplicationAllowance({ paid, free }: Pick<BillingStatus, 'paid'> & Partial<Pick<BillingStatus, 'free'>>): number {
  if (paid.hasActivePass) return Math.min(paid.employerSiteRemaining, paid.remaining);
  return free?.trial?.employerSites ? free.remaining : 0;
}
