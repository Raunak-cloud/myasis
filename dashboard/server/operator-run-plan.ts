import type { BillingStatus } from './billing.js';
import type { Entitlements } from './entitlements.js';
import {planDailyApplicationLimit} from '../src/pricing.js';

/** An authenticated operator may sponsor one bounded run, never an account upgrade. */
export const VIP_RUN_PLAN = { plan: 'intensive-pass', maxReviews: 400, timeoutMinutes: 120 } as const;

export function sponsoredRunEntitlements(current: Entitlements): Entitlements {
  return { ...current, tier: 'intensive', fineTune: true, advancedFilters: true,
    maxApplicationsPerDay:planDailyApplicationLimit({hasActiveIntensivePass:true}),
    indeedApplications: true, employerSources: true, evaluationsPerRun: VIP_RUN_PLAN.maxReviews };
}

/** This projection is never written to billing and never consumes the candidate's credits. */
export function sponsoredRunAllowance(current: BillingStatus): BillingStatus {
  return { ...current, paid: { ...current.paid, remaining: 100, employerSiteRemaining: 30,
    hasActivePass: true, hasActiveIntensivePass: true, unlimitedApplications: true }, totalRemaining: 100 };
}
