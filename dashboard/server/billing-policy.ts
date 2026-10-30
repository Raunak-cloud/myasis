import { PAID_PLANS, PASS_PLAN_KEYS, isPassPlanKey, type PaidPlanKey, type PassPlanKey } from '../src/pricing.js';
import type { BillingOffer, BillingOffers } from '../src/billing-offers.js';

export const DAY_MS = 86_400_000;
const QUOTE_LIFETIME_MS = 10 * 60_000;
export const CHECKOUT_LIFETIME_SECONDS = 31 * 60;
export class BillingPolicyError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.name = 'BillingPolicyError'; this.status = status; }
}
export interface ActivePass {
  grantId: string;
  planKey: PassPlanKey;
  expiresAt: string | null;
  periodStartedAt: string;
  priceCents: number;
  durationMs: number;
  applications: number;
}
export interface CheckoutQuote extends BillingOffer {
  version: 1;
  upgradePricingVersion?: 2;
  planKey: PaidPlanKey;
  kind: 'purchase' | 'upgrade' | 'topup';
  amountCents: number;
  target: { priceCents: number; durationDays: number; applications: number; employerSiteApplications: number };
  periodStartedAt: string | null;
}
function planRank(key: PassPlanKey): number { return PASS_PLAN_KEYS.indexOf(key); }

function prorate(deltaNumerator: bigint, denominator: bigint, remainingMs: number, roundUp: boolean): number {
  if (deltaNumerator <= 0n) return 0;
  const numerator = deltaNumerator * BigInt(remainingMs);
  return Number((numerator + (roundUp ? denominator - 1n : denominator / 2n)) / denominator);
}

export function quoteCheckout(planKey: PaidPlanKey, active: ActivePass | null, admin: boolean, now = Date.now()): CheckoutQuote {
  const plan = PAID_PLANS[planKey];
  if (admin) throw new BillingPolicyError('Your administrator access already includes these plans. No payment is needed.');
  const base = { version: 1 as const, planKey, quotedAt: now, sourceGrantId: active?.grantId ?? null,
    target: { priceCents: plan.priceCents, durationDays: plan.durationDays, applications: plan.applications, employerSiteApplications: plan.employerSiteApplications } };
  if (!isPassPlanKey(planKey)) {
    if (active?.planKey === 'intensive-pass') throw new BillingPolicyError('Get Owtomated already includes unlimited applications. No top-up is needed.');
    if (!active) throw new BillingPolicyError('Application top-ups require an active paid pass. Choose a pass first.');
    if (active.expiresAt && Date.parse(active.expiresAt) - now <= (CHECKOUT_LIFETIME_SECONDS + 4 * 60) * 1000) {
      throw new BillingPolicyError('This pass ends too soon for a top-up checkout. Choose a new pass after it expires.');
    }
    return { ...base, kind: 'topup', amountCents: plan.priceCents, expiresAt: active.expiresAt,
      additionalApplications: plan.applications, periodStartedAt: active.periodStartedAt };
  }
  if (!active) return { ...base, kind: 'purchase', amountCents: plan.priceCents, expiresAt: null,
    additionalApplications: plan.applications, periodStartedAt: null };
  if (planRank(planKey) === planRank(active.planKey)) throw new BillingPolicyError('Your pass is already active. You can purchase it again after it expires.');
  if (planRank(planKey) < planRank(active.planKey)) throw new BillingPolicyError('You cannot downgrade while your current pass is active.');
  if (!active.expiresAt) throw new BillingPolicyError('Your existing access has no expiry. Contact support to change this plan.');
  const remainingMs = Date.parse(active.expiresAt) - now;
  if (remainingMs <= (CHECKOUT_LIFETIME_SECONDS + 4 * 60) * 1000) throw new BillingPolicyError('Your pass expires too soon to upgrade. Choose a new plan after it expires.');
  if (!Number.isSafeInteger(active.durationMs) || active.durationMs <= 0 || !Number.isSafeInteger(active.priceCents) || active.priceCents < 0) {
    throw new BillingPolicyError('This pass needs a billing review before it can be upgraded. Contact support.');
  }
  const targetMs = BigInt(plan.durationDays * DAY_MS), sourceMs = BigInt(active.durationMs);
  const currentPlan = PAID_PLANS[active.planKey];
  const currentTermMs = BigInt(currentPlan.durationDays * DAY_MS);
  // Credit the existing tier's advertised value, including discounted or
  // granted passes. The payment ledger is an audit record, not the tier price.
  const amount = prorate(BigInt(plan.priceCents) * currentTermMs - BigInt(currentPlan.priceCents) * targetMs,
    targetMs * currentTermMs, remainingMs, false);
  // Stripe's AUD minimum is 50 cents. Waive tiny remaining differences;
  // never round them up or carry a balance into a future automatic charge.
  const amountCents = amount < 50 ? 0 : amount;
  const extra = prorate(BigInt(plan.applications) * sourceMs - BigInt(active.applications) * targetMs, targetMs * sourceMs, remainingMs, true);
  return { ...base, kind: 'upgrade', upgradePricingVersion: 2, amountCents, expiresAt: active.expiresAt,
    additionalApplications: Math.max(1, extra), periodStartedAt: active.periodStartedAt };
}

export function billingOffers(active: ActivePass | null, admin: boolean, now = Date.now()): BillingOffers {
  return Object.fromEntries(Object.keys(PAID_PLANS).map(key => {
    try { return [key, quoteCheckout(key as PaidPlanKey, active, admin, now)]; }
    catch (error) {
      if (!(error instanceof BillingPolicyError)) throw error;
      return [key, { kind: 'blocked', amountCents: null, quotedAt: now, sourceGrantId: active?.grantId ?? null,
        expiresAt: active?.expiresAt ?? null, additionalApplications: 0, reason: error.message }];
    }
  })) as BillingOffers;
}

export function validateQuoteTime(value: unknown, now = Date.now()): number {
  if (value === undefined) return now;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > now || now - value > QUOTE_LIFETIME_MS) {
    throw new BillingPolicyError('This upgrade quote has expired. Refresh the pricing page and try again.');
  }
  return value;
}
