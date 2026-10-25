import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import { PAID_PLANS, isPaidPlanKey, isPassPlanKey, type PaidPlanKey } from '../src/pricing.js';
import { activeBillingPass, type CheckoutIntent } from './billing-checkouts.js';
import { DAY_MS, type CheckoutQuote } from './billing-policy.js';
import { reportRedditConversion, type RedditMatchKeys } from './reddit-capi.js';

export function checkoutDurationDays(planKey: PaidPlanKey, metadata: Record<string, string> | null | undefined): number {
  if (!isPassPlanKey(planKey)) return 0;
  if (metadata?.durationDays !== undefined) {
    const days = Number(metadata.durationDays);
    if (!Number.isSafeInteger(days) || days <= 0) throw new Error('Invalid checkout access period.');
    return days;
  }
  return planKey === 'job-search-pass' || planKey === 'intensive-pass' ? 60 : PAID_PLANS[planKey].durationDays;
}
export interface FulfillmentResult {
  fulfilled: boolean; refunded?: boolean; planKey: PaidPlanKey; applications: number; durationDays: number;
  amountPaidCents: number; kind: 'purchase' | 'upgrade' | 'topup'; expiresAt?: string | null; conversionId?: string;
}

async function refundPayment(client: PoolClient, stripe: Stripe, session: Stripe.Checkout.Session, intentId: string): Promise<void> {
  let refundId: string | null = null;
  if (session.amount_total && session.payment_intent) {
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
    const refund = await stripe.refunds.create({ payment_intent: paymentIntent, reason: 'duplicate' }, { idempotencyKey: `checkout-refund:${session.id}` });
    if (refund.status === 'failed' || refund.status === 'canceled') throw new Error('The payment refund needs another attempt.');
    refundId = refund.id;
  } else if (session.amount_total) throw new Error('The payment intent is not available for refund yet.');
  await client.query("UPDATE billing_checkout_intents SET state='refunded',stripe_refund_id=$2 WHERE id=$1", [intentId, refundId]);
}

export async function fulfillPayment(pool: Pool, stripe: Stripe, sessionId: string, expectedUserId?: string, redditMatch?: RedditMatchKeys): Promise<FulfillmentResult> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== 'payment' || session.subscription) throw new Error('Only one-time checkout payments are accepted.');
  if (session.payment_status !== 'paid' && !(session.payment_status === 'no_payment_required' && session.amount_total === 0)) throw new Error('Payment has not completed.');
  const userId = session.metadata?.userId, planKey = session.metadata?.planKey;
  if (!userId || !isPaidPlanKey(planKey)) throw new Error('Payment metadata is incomplete.');
  if (expectedUserId && expectedUserId !== userId) throw new Error('This payment belongs to another account.');
  if (!Number.isSafeInteger(session.amount_total) || session.amount_total! < 0 || session.currency !== 'aud') throw new Error('Payment amount or currency is invalid.');
  const plan = PAID_PLANS[planKey];
  const legacyDuration = checkoutDurationDays(planKey, session.metadata);
  const baseResult: FulfillmentResult = { fulfilled: false, planKey, applications: plan.applications, durationDays: legacyDuration,
    amountPaidCents: session.amount_total!, kind: plan.kind === 'pass' ? 'purchase' : 'topup' };
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const existing = await client.query<{ applications_granted: number; purchase_kind: FulfillmentResult['kind']; pricing_snapshot: { durationDays?: number; expiresAt?: string | null } }>(
      'SELECT applications_granted,purchase_kind,pricing_snapshot FROM billing_purchases WHERE user_id=$1 AND stripe_checkout_session_id=$2', [userId, session.id]);
    if (existing.rows[0]) {
      await client.query('COMMIT'); transaction = false;
      const row = existing.rows[0];
      return { ...baseResult, applications: row.applications_granted, kind: row.purchase_kind,
        durationDays: row.pricing_snapshot.durationDays ?? legacyDuration, expiresAt: row.pricing_snapshot.expiresAt };
    }
    const intentToken = session.metadata?.checkoutIntentId;
    if (intentToken && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(intentToken)) throw new Error('Payment checkout reference is invalid.');
    const intents = await client.query<CheckoutIntent>(`SELECT * FROM billing_checkout_intents
      WHERE stripe_checkout_session_id=$1 OR id=$2::uuid FOR UPDATE`, [session.id, intentToken ?? null]);
    let intent = intents.rows[0];
    if (intent && (intent.user_id !== userId || intent.plan_key !== planKey
      || (intent.stripe_checkout_session_id && intent.stripe_checkout_session_id !== session.id))) throw new Error('Payment checkout reference belongs to another purchase.');
    if (intent && intent.stripe_mode !== (session.livemode ? 'live' : 'test')) throw new Error('Payment mode does not match its checkout.');
    if (intent?.state === 'refunded' || intent?.state === 'refund_pending') {
      await client.query('COMMIT'); transaction = false;
      if (intent.state === 'refund_pending') await refundPayment(client, stripe, session, intent.id);
      return { ...baseResult, applications: 0, refunded: true };
    }
    if (intentToken && !intent) throw new Error('The payment checkout reference is not available yet.');
    const quote: CheckoutQuote | undefined = intent?.quote;
    const active = await activeBillingPass(client, userId);
    const now = Date.now();
    let stale = false;
    if (quote) {
      stale = quote.version !== 1 || quote.planKey !== planKey
        || (quote.kind === 'upgrade' && quote.upgradePricingVersion !== 2)
        || session.amount_total! > quote.amountCents
        || (quote.kind === 'upgrade' && session.amount_total !== quote.amountCents)
        || (session.amount_subtotal !== null && session.amount_subtotal !== quote.amountCents)
        || (quote.kind === 'purchase' ? Boolean(active)
          : !active || active.grantId !== quote.sourceGrantId || active.expiresAt !== quote.expiresAt
            || (quote.kind === 'topup' && active.planKey === 'intensive-pass'))
        || (quote.expiresAt !== null && Date.parse(quote.expiresAt) <= now);
    } else {
      // Old links can still reach Stripe after deployment. Never bank a second
      // full pass or a downgrade from one of those links; return the payment.
      stale = plan.kind === 'pass' ? Boolean(active) : !active || active.planKey === 'intensive-pass';
    }
    if (stale) {
      if (!intent) {
        const id = randomUUID();
        await client.query(`INSERT INTO billing_checkout_intents(id,user_id,plan_key,stripe_mode,state,stripe_checkout_session_id,quote,stripe_params,expires_at)
          VALUES($1,$2,$3,$4,'refund_pending',$5,'{}','{}',now())`, [id, userId, planKey, session.livemode ? 'live' : 'test', session.id]);
        intent = { id } as CheckoutIntent;
      } else await client.query("UPDATE billing_checkout_intents SET state='refund_pending',stripe_checkout_session_id=$2 WHERE id=$1", [intent.id, session.id]);
      await client.query('COMMIT'); transaction = false;
      await refundPayment(client, stripe, session, intent.id);
      return { ...baseResult, applications: 0, refunded: true };
    }

    const durationDays = quote?.target.durationDays ?? legacyDuration;
    const kind = quote?.kind ?? (plan.kind === 'pass' ? 'purchase' : 'topup');
    const applications = quote?.additionalApplications ?? plan.applications;
    const startsAt = new Date(now).toISOString();
    const expiresAt = kind === 'purchase' ? new Date(now + durationDays * DAY_MS).toISOString()
      : quote?.expiresAt ?? active?.expiresAt ?? null;
    const snapshot = { priceCents: kind === 'upgrade' ? quote!.target.priceCents : session.amount_total!,
      durationMs: durationDays * DAY_MS, durationDays, applications: quote?.target.applications ?? plan.applications,
      periodStartedAt: kind === 'upgrade' ? quote!.periodStartedAt : startsAt, expiresAt };
    const purchase = await client.query<{ id: string }>(`INSERT INTO billing_purchases
      (user_id,stripe_checkout_session_id,stripe_payment_intent_id,plan_key,applications_granted,amount_paid,currency,purchase_kind,pricing_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(stripe_checkout_session_id) DO NOTHING RETURNING id`,
    [userId, session.id, typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      planKey, applications, session.amount_total, session.currency, kind, JSON.stringify(snapshot)]);
    if (!purchase.rows[0]) { await client.query('COMMIT'); transaction = false; return baseResult; }
    await client.query(`INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5)`, [userId, purchase.rows[0].id, applications, expiresAt, startsAt]);
    const employerFull = quote?.target.employerSiteApplications ?? plan.employerSiteApplications;
    if (employerFull > 0) {
      const employerCredits = kind === 'upgrade' ? Math.max(1, Math.ceil(employerFull * (Date.parse(expiresAt!) - quote!.quotedAt) / (durationDays * DAY_MS))) : employerFull;
      await client.query(`INSERT INTO employer_site_credit_grants(user_id,purchase_id,credits_total,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5)`, [userId, purchase.rows[0].id, employerCredits, expiresAt, startsAt]);
    }
    if (intent) await client.query("UPDATE billing_checkout_intents SET state='fulfilled',stripe_checkout_session_id=$2 WHERE id=$1", [intent.id, session.id]);
    await client.query('COMMIT'); transaction = false;
    const conversionId = `purchase:${purchase.rows[0].id}`;
    reportRedditConversion({ trackingType: 'Purchase', conversionId, externalId: userId,
      email: session.customer_details?.email ?? undefined, valueDecimal: session.amount_total! / 100,
      currency: session.currency.toUpperCase(), itemCount: 1, match: redditMatch });
    return { fulfilled: true, planKey, applications, durationDays, amountPaidCents: session.amount_total!, kind, expiresAt, conversionId };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
