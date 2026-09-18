import Stripe from 'stripe';
import { getPool, one } from './db/index.js';
import { readEnv } from './runner.js';
import {
  FREE_APPLICATIONS,
  PAID_PLANS,
  isPaidPlanKey,
  type PaidPlanKey,
} from '../src/pricing.js';
import type { SessionUser } from './auth.js';

/**
 * Resolved per call rather than at module load — like `billingEnv()` below —
 * so editing ADMIN_EMAILS in seek-bot/.env takes effect immediately, no
 * dashboard restart needed.
 */
function adminEmails(): Set<string> {
  const env = readEnv();
  return new Set(
    (process.env.ADMIN_EMAILS ?? env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Admin accounts are exempt from the free/paid application allowance entirely. */
export function isAdmin(email?: string | null): boolean {
  return Boolean(email && adminEmails().has(email.toLowerCase()));
}

/** Large but finite so JSON/arithmetic (e.g. Math.min with a run cap) stays well-behaved — Infinity serialises to null. */
const ADMIN_UNLIMITED = 1_000_000;

export type StripeMode = 'live' | 'test';

/**
 * Which of the two sets of Stripe keys is in use.
 *
 * Live and test are separate worlds as far as Stripe is concerned: separate
 * keys, separate webhooks, separate customers. Keeping both sets in the file
 * and switching between them means a test run never involves re-pasting
 * keys, which is how a live key once ended up in a chat.
 */
export function stripeMode(): StripeMode {
  const env = readEnv();
  const mode = (process.env.STRIPE_MODE ?? env.STRIPE_MODE ?? '').trim().toLowerCase();
  return mode === 'test' ? 'test' : 'live';
}

export interface PaymentsState {
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
  return new Stripe(billingEnv().secretKey);
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
    expiresAt: string | null;
    hasActivePass: boolean;
    hasActiveJobSearchPass: boolean;
    hasActiveIntensivePass: boolean;
  };
  totalRemaining: number;
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
        expiresAt: null,
        hasActivePass: true,
        hasActiveJobSearchPass: true,
        hasActiveIntensivePass: true,
      },
      totalRemaining: ADMIN_UNLIMITED,
    };
  }

  const paid = await one<{
    remaining: string;
    expires_at: Date | null;
    active_pass_expires_at: Date | null;
    job_search_pass_expires_at: Date | null;
    intensive_pass_expires_at: Date | null;
  }>(
    `SELECT
       COALESCE(sum(g.credits_total - g.credits_used), 0)::text AS remaining,
       max(g.expires_at) AS expires_at,
       max(g.expires_at) FILTER (
         WHERE p.plan_key IN ('job-search-pass', 'intensive-pass')
       ) AS active_pass_expires_at,
       max(g.expires_at) FILTER (
         WHERE p.plan_key = 'job-search-pass'
       ) AS job_search_pass_expires_at,
       max(g.expires_at) FILTER (
         WHERE p.plan_key = 'intensive-pass'
       ) AS intensive_pass_expires_at
     FROM application_credit_grants g
     JOIN billing_purchases p ON p.id = g.purchase_id
     WHERE g.user_id = $1 AND g.expires_at > now()`,
    [userId],
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
  const paidRemaining = Number(paid?.remaining ?? 0);
  const hasActivePass = Boolean(paid?.active_pass_expires_at);
  return {
    configured: paymentsConfigured(),
    free: {
      allowance: FREE_APPLICATIONS,
      used: freeUsed,
      remaining: freeRemaining,
    },
    paid: {
      remaining: paidRemaining,
      expiresAt: paid?.expires_at ? new Date(paid.expires_at).toISOString() : null,
      hasActivePass,
      hasActiveJobSearchPass: Boolean(paid?.job_search_pass_expires_at),
      hasActiveIntensivePass: Boolean(paid?.intensive_pass_expires_at),
    },
    totalRemaining: freeRemaining + paidRemaining,
  };
}

export async function createCheckout(
  user: SessionUser,
  planKey: PaidPlanKey,
): Promise<{ id: string; url: string }> {
  const plan = PAID_PLANS[planKey];
  /**
   * A top-up adds to a pass; it is not a way onto the free plan's allowance
   * at a lower price. Checked here, not only on the page, because the page
   * is not what decides.
   */
  if (planKey === 'application-top-up') {
    const status = await billingStatus(user.id, user.email);
    if (!status.paid.hasActiveJobSearchPass && !status.paid.hasActiveIntensivePass) {
      throw new Error('A top-up adds applications to a pass. Choose a Job Search Pass or Intensive Pass first.');
    }
  }
  const env = billingEnv();
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_creation: 'always',
    customer_email: user.email,
    client_reference_id: user.id,
    allow_promotion_codes: true,
    automatic_tax: { enabled: env.automaticTax },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'aud',
        unit_amount: plan.priceCents,
        product_data: {
          name: plan.name,
          description: `${plan.applications} successful applications · one-time payment, valid for ${plan.validDays} days`,
        },
      },
    }],
    metadata: { userId: user.id, planKey },
    payment_intent_data: { metadata: { userId: user.id, planKey } },
    success_url: `${env.baseUrl}/?tab=pricing&payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.baseUrl}/?tab=pricing&payment=cancelled`,
  });
  if (!session.url) throw new Error('The payment provider did not return a checkout URL.');
  return { id: session.id, url: session.url };
}

export async function fulfillCheckoutSession(
  sessionId: string,
  expectedUserId?: string,
): Promise<{ fulfilled: boolean; planKey: PaidPlanKey; applications: number }> {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') throw new Error('Payment has not completed.');
  const userId = session.metadata?.userId;
  const planKeyValue = session.metadata?.planKey;
  if (!userId || !isPaidPlanKey(planKeyValue)) throw new Error('Payment metadata is incomplete.');
  if (expectedUserId && expectedUserId !== userId) throw new Error('This payment belongs to another account.');
  const plan = PAID_PLANS[planKeyValue];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const purchase = await client.query<{ id: string }>(
      `INSERT INTO billing_purchases (
         user_id, stripe_checkout_session_id, stripe_payment_intent_id,
         plan_key, applications_granted, amount_paid, currency, paid_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (stripe_checkout_session_id) DO NOTHING
       RETURNING id`,
      [
        userId,
        session.id,
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
        plan.key,
        plan.applications,
        session.amount_total ?? plan.priceCents,
        session.currency ?? 'aud',
      ],
    );
    if (!purchase.rows[0]) {
      await client.query('COMMIT');
      return { fulfilled: false, planKey: planKeyValue, applications: plan.applications };
    }
    await client.query(
      `INSERT INTO application_credit_grants (
         user_id, purchase_id, credits_total, expires_at
       ) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [userId, purchase.rows[0].id, plan.applications, String(plan.validDays)],
    );
    await client.query('COMMIT');
    return { fulfilled: true, planKey: planKeyValue, applications: plan.applications };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const { webhookSecret } = billingEnv();
  if (!webhookSecret) throw new Error('The payment webhook is not configured.');
  const stripe = stripeClient();
  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    await fulfillCheckoutSession(session.id);
  }
}

/** Uses the monthly free allowance first, then the paid grant that expires soonest. */
export async function consumeSuccessfulApplication(userId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // One account at a time through this check, so two runs cannot both take the last free application.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const usage = await client.query<{ used: string }>(
      `SELECT COALESCE(sum(successful_applications), 0)::text AS used
         FROM monthly_application_usage
        WHERE user_id = $1`,
      [userId],
    );
    if (Number(usage.rows[0]?.used ?? 0) < FREE_APPLICATIONS) {
      await client.query(
        `INSERT INTO monthly_application_usage (user_id, month_start, successful_applications)
         VALUES ($1, date_trunc('month', now())::date, 1)
         ON CONFLICT (user_id, month_start) DO UPDATE SET
           successful_applications = monthly_application_usage.successful_applications + 1`,
        [userId],
      );
    } else {
      const grant = await client.query<{ id: string }>(
        `SELECT id
           FROM application_credit_grants
          WHERE user_id = $1 AND expires_at > now() AND credits_used < credits_total
          ORDER BY expires_at, id
          LIMIT 1
          FOR UPDATE`,
        [userId],
      );
      if (!grant.rows[0]) throw new Error('No application allowance remains.');
      await client.query(
        `UPDATE application_credit_grants
            SET credits_used = credits_used + 1
          WHERE id = $1`,
        [grant.rows[0].id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
