import type { PaidPlanKey } from './pricing.js';

export interface BillingOffer {
  kind: 'purchase' | 'upgrade' | 'topup' | 'blocked';
  amountCents: number | null;
  quotedAt: number;
  sourceGrantId: string | null;
  expiresAt: string | null;
  additionalApplications: number;
  reason?: string;
}
export type BillingOffers = Record<PaidPlanKey, BillingOffer>;
