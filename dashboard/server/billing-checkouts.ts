import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import { PAID_PLANS, PASS_PLAN_KEYS, type PaidPlanKey } from '../src/pricing.js';
import { BillingPolicyError, CHECKOUT_LIFETIME_SECONDS, quoteCheckout, validateQuoteTime, type ActivePass, type CheckoutQuote } from './billing-policy.js';

type Db = Pick<PoolClient, 'query'>;
export interface CheckoutOptions { quotedAt?: unknown; sourceGrantId?: unknown; amountCents?: unknown; expiresAt?: unknown }
export interface CheckoutIntent {
  id: string; user_id: string; plan_key: PaidPlanKey; stripe_mode: 'live' | 'test'; state: string;
  stripe_checkout_session_id: string | null; quote: CheckoutQuote;
  stripe_params: Stripe.Checkout.SessionCreateParams; expires_at: Date;
}

export async function activeBillingPass(db: Db, userId: string): Promise<ActivePass | null> {
  const result = await db.query<{
    id: string; plan_key: ActivePass['planKey']; expires_at: Date | null; created_at: Date;
    amount_paid: number; applications_granted: number; currency: string;
    pricing_snapshot: { priceCents?: number; durationMs?: number; applications?: number; periodStartedAt?: string };
  }>(`SELECT g.id::text, p.plan_key, g.expires_at, g.created_at, p.amount_paid,
             p.applications_granted, p.currency, p.pricing_snapshot
      FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
      WHERE g.user_id=$1 AND p.plan_key=ANY($2) AND (g.expires_at IS NULL OR g.expires_at>now())
      ORDER BY CASE p.plan_key WHEN 'intensive-pass' THEN 3 WHEN 'job-search-pass' THEN 2 ELSE 1 END DESC,
               g.expires_at DESC NULLS FIRST, g.id DESC LIMIT 1`, [userId, [...PASS_PLAN_KEYS]]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.currency.toLowerCase() !== 'aud') throw new BillingPolicyError('Contact support to review this pass before changing plans.');
  const snapshot = row.pricing_snapshot ?? {};
  return { grantId: row.id, planKey: row.plan_key, expiresAt: row.expires_at?.toISOString() ?? null,
    periodStartedAt: snapshot.periodStartedAt ?? row.created_at.toISOString(),
    priceCents: snapshot.priceCents ?? row.amount_paid,
    durationMs: snapshot.durationMs ?? (row.expires_at ? row.expires_at.getTime() - row.created_at.getTime() : 0),
    applications: snapshot.applications ?? row.applications_granted };
}

function assertExpectedOffer(options: CheckoutOptions, quote: CheckoutQuote): void {
  if ((options.sourceGrantId !== undefined && options.sourceGrantId !== quote.sourceGrantId)
    || (options.amountCents !== undefined && options.amountCents !== quote.amountCents)
    || (options.expiresAt !== undefined && options.expiresAt !== quote.expiresAt)) {
    throw new BillingPolicyError('Your plan or upgrade price has changed. Refresh pricing and try again.');
  }
}

function priceData(quote: CheckoutQuote): Stripe.Checkout.SessionCreateParams.LineItem.PriceData {
  const plan = PAID_PLANS[quote.planKey];
  const end = quote.expiresAt ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(quote.expiresAt)) : '';
  const description = quote.kind === 'upgrade'
    ? `${quote.planKey === 'intensive-pass' ? 'Unlimited applications' : `${quote.additionalApplications} additional application credits`} · access ends ${end} · no automatic renewal`
    : plan.kind === 'pass'
      ? `${quote.planKey === 'intensive-pass' ? 'Unlimited applications' : `${quote.additionalApplications} application credits`} · ${quote.target.durationDays} days · no automatic renewal`
      : plan.description;
  return { currency: 'aud', unit_amount: quote.amountCents, tax_behavior: 'inclusive',
    product_data: { name: quote.kind === 'upgrade' ? `Upgrade to ${plan.name}` : plan.name, description } };
}

/** Serialize checkout links separately from application-credit deductions. Persist
 * Stripe's exact request before sending it, so a timeout can safely resume it. */
export async function managedCheckout(
  pool: Pool, stripeSource: Stripe | (() => Stripe),
  user: { id: string; email: string }, planKey: PaidPlanKey, admin: boolean,
  env: { mode: 'live' | 'test'; baseUrl: string; automaticTax: boolean }, options: CheckoutOptions = {},
): Promise<{ id: string; url: string }> {
  const client = await pool.connect();
  const lock = `billing-checkout:${user.id}:${env.mode}`;
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]); locked = true;
    const active = await activeBillingPass(client, user.id);
    const quotedAt = validateQuoteTime(options.quotedAt);
    const quote = quoteCheckout(planKey, active, admin, quotedAt);
    assertExpectedOffer(options, quote);
    const stripe = typeof stripeSource === 'function' ? stripeSource() : stripeSource;
    const pendingResult = await client.query<CheckoutIntent>(
      `SELECT * FROM billing_checkout_intents WHERE user_id=$1 AND stripe_mode=$2
        AND state IN ('creating','open','processing') ORDER BY created_at DESC LIMIT 1`, [user.id, env.mode]);
    const pending = pendingResult.rows[0];
    if (pending) {
      let session: Stripe.Checkout.Session;
      try {
        session = pending.stripe_checkout_session_id
          ? await stripe.checkout.sessions.retrieve(pending.stripe_checkout_session_id)
          : await stripe.checkout.sessions.create(pending.stripe_params, { idempotencyKey: `checkout:${pending.id}` });
      } catch (error) {
        // An invalid request cannot have created a payable session. Network and
        // ambiguous errors retain the same request/idempotency key for retry.
        if (!pending.stripe_checkout_session_id && (error as { type?: string }).type === 'StripeInvalidRequestError') {
          await client.query("UPDATE billing_checkout_intents SET state='failed' WHERE id=$1", [pending.id]);
        }
        throw error;
      }
      if (session.payment_status === 'paid' || session.status === 'complete') {
        await client.query("UPDATE billing_checkout_intents SET stripe_checkout_session_id=$2,state='processing' WHERE id=$1 AND state IN ('creating','open','processing')", [pending.id, session.id]);
        throw new BillingPolicyError('Your previous payment is being confirmed. Refresh pricing before opening another checkout.');
      }
      const same = pending.plan_key === planKey && pending.quote.sourceGrantId === quote.sourceGrantId
        && pending.quote.expiresAt === quote.expiresAt && pending.quote.amountCents === quote.amountCents
        && pending.quote.additionalApplications === quote.additionalApplications && pending.expires_at.getTime() > Date.now();
      if (session.status === 'open' && same && session.url) {
        await client.query("UPDATE billing_checkout_intents SET stripe_checkout_session_id=$2,state='open' WHERE id=$1 AND state='creating'", [pending.id, session.id]);
        // Reusing a checkout must not silently charge a different displayed price.
        assertExpectedOffer(options, pending.quote);
        return { id: session.id, url: session.url };
      }
      if (session.status === 'open') {
        try { await stripe.checkout.sessions.expire(session.id); }
        catch { throw new BillingPolicyError('The previous checkout is changing. Refresh pricing before trying again.'); }
      }
      await client.query("UPDATE billing_checkout_intents SET stripe_checkout_session_id=$2,state='expired' WHERE id=$1 AND state IN ('creating','open','processing')", [pending.id, session.id]);
    }
    const id = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS;
    const metadata = { userId: user.id, planKey, durationDays: String(quote.target.durationDays), checkoutIntentId: id, checkoutVersion: '1' };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment', expires_at: expiresAt, customer_creation: 'always', customer_email: user.email,
      client_reference_id: user.id, allow_promotion_codes: quote.kind !== 'upgrade',
      automatic_tax: { enabled: env.automaticTax }, payment_method_collection: 'if_required',
      line_items: [{ quantity: 1, price_data: priceData(quote) }], metadata,
      ...(quote.amountCents > 0 ? { payment_intent_data: { metadata } } : {}),
      success_url: `${env.baseUrl}/?tab=pricing&payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.baseUrl}/?tab=pricing&payment=cancelled`,
    };
    await client.query(`INSERT INTO billing_checkout_intents(id,user_id,plan_key,stripe_mode,quote,stripe_params,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))`, [id, user.id, planKey, env.mode, JSON.stringify(quote), JSON.stringify(params), expiresAt]);
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout:${id}` });
    } catch (error) {
      if ((error as { type?: string }).type === 'StripeInvalidRequestError') {
        await client.query("UPDATE billing_checkout_intents SET state='failed' WHERE id=$1 AND state='creating'", [id]);
      }
      throw error;
    }
    if (!session.url) throw new Error('The payment provider did not return a checkout URL.');
    await client.query("UPDATE billing_checkout_intents SET stripe_checkout_session_id=$2,state='open' WHERE id=$1 AND state='creating'", [id, session.id]);
    return { id: session.id, url: session.url };
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); }
      catch (error) { releaseError = error instanceof Error ? error : new Error('Could not release checkout lock.'); }
    }
    client.release(releaseError);
  }
}
