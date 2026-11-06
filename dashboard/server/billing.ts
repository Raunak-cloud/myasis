import Stripe from 'stripe';
import { consumeApplicationCredit } from './application-credits.js';
import { getPool, one } from './db/index.js';
import { readEnv } from './runner.js';
import {
  FREE_APPLICATIONS,
  PAID_PLANS,
  PASS_PLAN_KEYS,
  type PaidPlanKey,
} from '../src/pricing.js';
import type { SessionUser } from './auth.js';
import { isAdmin } from './admin-access.js';
export { isAdmin, adminAddresses } from './admin-access.js';
import type { RedditMatchKeys } from './reddit-capi.js';
import { activeBillingPass, managedCheckout, type CheckoutOptions } from './billing-checkouts.js';
import { billingOffers } from './billing-policy.js';
import { fulfillPayment } from './billing-fulfillment.js';
import type { BillingOffers } from '../src/billing-offers.js';
export { BillingPolicyError } from './billing-policy.js';

/** Large but finite so JSON/arithmetic (e.g. Math.min with a run cap) stays well-behaved — Infinity serialises to null. */
const ADMIN_UNLIMITED = 1_000_000;

type StripeMode = 'live' | 'test';

/**
 * Which of the two sets of Stripe keys is in use.
 *
 * Live and test are separate worlds as far as Stripe is concerned: separate
 * keys, separate webhooks, separate customers. Keeping both sets in the file
 * and switching between them means a test run never involves re-pasting
 * keys, which is how a live key once ended up in a chat.
 */
function stripeMode(): StripeMode {
  const env = readEnv();
  const mode = (process.env.STRIPE_MODE ?? env.STRIPE_MODE ?? '').trim().toLowerCase();
  return mode === 'test' ? 'test' : 'live';
}

interface PaymentsState {
  mode: StripeMode;
  configured: boolean;
  /** Why checkout is off, in words the operator can act on. */
  problem: string | null;
}

/**
 * Whether checkout can run, and if not, why.
 *
 * A key in the wrong slot is refused rather than tolerated: a test key in
 * the live slot would process test payments while the dashboard said live,
 * which is the one mistake this switch exists to prevent.
 */
export function paymentsState(): PaymentsState {
  const { mode, secretKey, webhookSecret } = billingEnv();
  if (!secretKey && !webhookSecret) return { mode, configured: false, problem: `No ${mode} keys are set.` };
  if (!secretKey) return { mode, configured: false, problem: `The ${mode} secret key is not set.` };
  if (!webhookSecret) return { mode, configured: false, problem: `The ${mode} webhook signing secret is not set.` };
  if (mode === 'live' && /^[sr]k_test_/.test(secretKey)) {
    return { mode, configured: false, problem: 'Live mode is selected but the key in the live slot is a test key.' };
  }
  if (mode === 'test' && /^[sr]k_live_/.test(secretKey)) {
    return { mode, configured: false, problem: 'Test mode is selected but the key in the test slot is a live key.' };
  }
  return { mode, configured: true, problem: null };
}

function billingEnv() {
  const env = readEnv();
  const mode = stripeMode();
  const pick = (liveKey: string, testKey: string) => {
    const key = mode === 'test' ? testKey : liveKey;
    return (process.env[key] ?? env[key] ?? '').trim();
  };
  return {
    mode,
    secretKey: pick('STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY'),
    webhookSecret: pick('STRIPE_WEBHOOK_SECRET', 'STRIPE_TEST_WEBHOOK_SECRET'),
    baseUrl: (process.env.APP_BASE_URL ?? env.APP_BASE_URL ?? 'http://localhost:5180').replace(/\/$/, ''),
    automaticTax: (process.env.STRIPE_AUTOMATIC_TAX ?? env.STRIPE_AUTOMATIC_TAX) === 'true',
  };
}

function stripeClient(): Stripe {
  const state = paymentsState();
  if (!state.configured) throw new Error(`Payments are not configured yet. ${state.problem}`);
  return new Stripe(billingEnv().secretKey, { timeout: 10_000, maxNetworkRetries: 1 });
}

export function paymentsConfigured(): boolean {
  return paymentsState().configured;
}

export interface BillingStatus {
  configured: boolean;
  free: {
    allowance: number;
    used: number;
    remaining: number;
  };
  paid: {
    remaining: number;
    employerSiteRemaining: number;
    expiresAt: string | null;
    hasActivePass: boolean;
    hasActiveEssentialPass: boolean;
    hasActiveJobSearchPass: boolean;
    hasActiveIntensivePass: boolean;
    unlimitedApplications?: boolean;
  };
  totalRemaining: number;
  offers?: BillingOffers;
}

export async function billingStatus(userId: string, email?: string | null): Promise<BillingStatus> {
  if (isAdmin(email)) {
    return {
      configured: paymentsConfigured(),
      free: {
        allowance: FREE_APPLICATIONS,
        used: 0,
        remaining: FREE_APPLICATIONS,
      },
      paid: {
        remaining: ADMIN_UNLIMITED,
        employerSiteRemaining: ADMIN_UNLIMITED,
        expiresAt: null,
        hasActivePass: true,
        hasActiveEssentialPass: true,
        hasActiveJobSearchPass: true,
        hasActiveIntensivePass: true,
        unlimitedApplications: true,
      },
      totalRemaining: ADMIN_UNLIMITED,
      offers: billingOffers(null, true),
    };
  }

  const paid = await one<{
    remaining: string;
    employer_site_remaining: string;
    essential_expires_at: Date | null;
    job_search_expires_at: Date | null;
    intensive_expires_at: Date | null;
    essential_forever: boolean;
    job_search_forever: boolean;
    intensive_forever: boolean;
    essential_pass: boolean;
    job_search_pass: boolean;
    intensive_pass: boolean;
  }>(
    `WITH passes AS (
       SELECT p.plan_key, g.expires_at
         FROM application_credit_grants g
         JOIN billing_purchases p ON p.id = g.purchase_id
        WHERE g.user_id = $1
          AND p.plan_key = ANY($2)
          AND (g.expires_at IS NULL OR g.expires_at > now())
     )
     SELECT
       (SELECT COALESCE(sum(g.credits_total - g.credits_used), 0)::text
          FROM application_credit_grants g
         WHERE g.user_id = $1
           AND (g.expires_at IS NULL OR g.expires_at > now())
           AND g.credits_used < g.credits_total) AS remaining,
       max(expires_at) FILTER (WHERE plan_key = 'essential-pass') AS essential_expires_at,
       max(expires_at) FILTER (WHERE plan_key = 'job-search-pass') AS job_search_expires_at,
       max(expires_at) FILTER (WHERE plan_key = 'intensive-pass') AS intensive_expires_at,
       COALESCE(bool_or(plan_key = 'essential-pass' AND expires_at IS NULL), false) AS essential_forever,
       COALESCE(bool_or(plan_key = 'job-search-pass' AND expires_at IS NULL), false) AS job_search_forever,
       COALESCE(bool_or(plan_key = 'intensive-pass' AND expires_at IS NULL), false) AS intensive_forever,
       COALESCE(bool_or(plan_key = 'essential-pass'), false) AS essential_pass,
       COALESCE(bool_or(plan_key = 'job-search-pass'), false) AS job_search_pass,
       COALESCE(bool_or(plan_key = 'intensive-pass'), false) AS intensive_pass,
       (SELECT COALESCE(sum(e.credits_total - e.credits_used), 0)::text
          FROM employer_site_credit_grants e
         WHERE e.user_id = $1
           AND (e.expires_at IS NULL OR e.expires_at > now())
           AND e.credits_used < e.credits_total) AS employer_site_remaining
     FROM passes`,
    [userId, [...PASS_PLAN_KEYS]],
  );
  // The free allowance is for the life of the account, not the month: every row counts.
  const usage = await one<{ used: string }>(
    `SELECT COALESCE(sum(successful_applications), 0)::text AS used
       FROM monthly_application_usage
      WHERE user_id = $1`,
    [userId],
  );
  const freeUsed = Number(usage?.used ?? 0);
  const freeRemaining = Math.max(0, FREE_APPLICATIONS - freeUsed);
  const paidRemaining = paid?.intensive_pass ? ADMIN_UNLIMITED : Number(paid?.remaining ?? 0);
  const hasActivePass = Boolean(paid?.essential_pass || paid?.job_search_pass || paid?.intensive_pass);
  const activePassExpiry = paid?.intensive_pass
    ? (paid.intensive_forever ? null : paid.intensive_expires_at)
    : paid?.job_search_pass
      ? (paid.job_search_forever ? null : paid.job_search_expires_at)
      : paid?.essential_pass
        ? (paid.essential_forever ? null : paid.essential_expires_at)
        : null;
  return {
    configured: paymentsConfigured(),
    free: {
      allowance: FREE_APPLICATIONS,
      used: freeUsed,
      remaining: freeRemaining,
    },
    paid: {
      remaining: paidRemaining,
      employerSiteRemaining: paid?.intensive_pass ? ADMIN_UNLIMITED : Number(paid?.employer_site_remaining ?? 0),
      expiresAt: activePassExpiry ? new Date(activePassExpiry).toISOString() : null,
      hasActivePass,
      hasActiveEssentialPass: Boolean(paid?.essential_pass),
      hasActiveJobSearchPass: Boolean(paid?.job_search_pass),
      hasActiveIntensivePass: Boolean(paid?.intensive_pass),
      unlimitedApplications: Boolean(paid?.intensive_pass),
    },
    totalRemaining: freeRemaining + paidRemaining,
    offers: billingOffers(await activeBillingPass(getPool(), userId), false),
  };
}

/** The same product description and amount shown by Stripe at payment. */
export function checkoutPriceData(planKey: PaidPlanKey) {
  const plan = PAID_PLANS[planKey];
  return {
    currency: 'aud', unit_amount: plan.priceCents, tax_behavior: 'inclusive' as const,
    product_data: {
      name: plan.name,
      description: plan.kind === 'pass'
        ? `${planKey === 'intensive-pass' ? 'Unlimited applications' : `${plan.applications} application credits`} · ${plan.durationDays} days · no automatic renewal`
        : plan.description,
    },
  };
}

export { checkoutDurationDays } from './billing-fulfillment.js';

export async function createCheckout(user: SessionUser, planKey: PaidPlanKey, options: CheckoutOptions = {}) {
  return managedCheckout(getPool(), stripeClient, user, planKey, isAdmin(user.email), billingEnv(), options);
}

export async function fulfillCheckoutSession(sessionId: string, expectedUserId?: string, redditMatch?: RedditMatchKeys) {
  return fulfillPayment(getPool(), stripeClient(), sessionId, expectedUserId, redditMatch);
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const { webhookSecret } = billingEnv();
  if (!webhookSecret) throw new Error('The payment webhook is not configured.');
  const stripe = stripeClient();
  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      await fulfillCheckoutSession(session.id);
    } else await recordCheckoutState(session, 'processing');
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object as Stripe.Checkout.Session;
    await recordCheckoutState(session, event.type === 'checkout.session.expired' ? 'expired' : 'failed');
  }
}

async function recordCheckoutState(session: Stripe.Checkout.Session, state: 'processing' | 'expired' | 'failed'): Promise<void> {
  const token = session.metadata?.checkoutIntentId;
  const intentId = token && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token) ? token : null;
  await getPool().query(`UPDATE billing_checkout_intents SET state=$3,stripe_checkout_session_id=$1
    WHERE (stripe_checkout_session_id=$1 OR id=$2::uuid) AND user_id::text=$4 AND plan_key=$5 AND stripe_mode=$6
      AND state IN ('creating','open','processing')`,
  [session.id, intentId, state, session.metadata?.userId, session.metadata?.planKey, session.livemode ? 'live' : 'test']);
}

/** Uses free capacity first for board applications; employer sites require both paid and employer-site credits. */
export async function consumeSuccessfulApplication(userId: string, external = false): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await consumeApplicationCredit(client, userId, external);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
