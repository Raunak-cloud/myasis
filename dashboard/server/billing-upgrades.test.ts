import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type Stripe from 'stripe';
import { getPool } from './db/index.js';
import { activeBillingPass, managedCheckout } from './billing-checkouts.js';
import { fulfillPayment } from './billing-fulfillment.js';
import { quoteCheckout, billingOffers, DAY_MS, type ActivePass } from './billing-policy.js';
import { billingStatus } from './billing.js';
import { PAID_PLANS, type PassPlanKey } from '../src/pricing.js';

// The deployment host has real analytics credentials. Fixture payments must
// never be reported as real conversions, even when run on that host.
process.env.REDDIT_CONVERSION_TOKEN = '';

const now = Date.now();
const pool = getPool();
const schema = `billing_upgrades_${randomUUID().replaceAll('-', '')}`;
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
before(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(sql);
  await pool.query(`INSERT INTO users(id,email) SELECT id,'fixture-'||id||'@fixture.invalid' FROM generate_series(1,30) id`);
});
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

const env = { mode: 'test' as const, baseUrl: 'https://fixture.invalid', automaticTax: false };
const sessions = new Map<string, Stripe.Checkout.Session>();
const keys = new Map<string, string>();
const requests: Stripe.Checkout.SessionCreateParams[] = [];
const refunds = new Map<string, string>();
let loseResponse = false;
let rejectRequest = false;
const fake = {
  checkout: { sessions: {
    async create(params: Stripe.Checkout.SessionCreateParams, options: { idempotencyKey: string }) {
      assert.equal(params.payment_method_collection, undefined, 'one-time Checkout rejects this subscription-only option');
      if (rejectRequest) { rejectRequest = false; throw Object.assign(new Error('Fixture invalid Stripe request'), { type: 'StripeInvalidRequestError' }); }
      if (keys.has(options.idempotencyKey)) return sessions.get(keys.get(options.idempotencyKey)!)!;
      requests.push(params);
      const id = `cs_fixture_${randomUUID()}`;
      const amount = params.line_items![0].price_data!.unit_amount!;
      const session = { id, url: `https://checkout.stripe.com/fixture/${id}`, mode: params.mode,
        livemode: false, status: 'open', payment_status: 'unpaid', amount_total: amount, amount_subtotal: amount,
        currency: 'aud', metadata: params.metadata, created: Math.floor(Date.now()/1000),
        payment_intent: amount > 0 ? `pi_${id}` : null, subscription: null, customer_details: null } as Stripe.Checkout.Session;
      sessions.set(id, session); keys.set(options.idempotencyKey, id);
      if (loseResponse) { loseResponse = false; throw new Error('Fixture lost the response after Stripe created checkout'); }
      return session;
    },
    async retrieve(id: string) { const session = sessions.get(id); assert.ok(session); return session; },
    async expire(id: string) { const session = sessions.get(id)!; assert.equal(session.status, 'open'); session.status = 'expired'; session.url = null; return session; },
  } },
  refunds: { async create(params: { payment_intent: string }, options: { idempotencyKey: string }) {
    const id = refunds.get(options.idempotencyKey) ?? `re_${params.payment_intent}`;
    refunds.set(options.idempotencyKey, id); return { id, status: 'succeeded' };
  } },
} as unknown as Stripe;
const user = (id: number) => ({ id: String(id), email: `fixture-${id}@fixture.invalid` });
async function checkout(id: number, key: PassPlanKey, options = {}) { return managedCheckout(pool, fake, user(id), key, false, env, options); }
function paid(id: string, discounted?: number) {
  const session = sessions.get(id)!; assert.equal(session.status, 'open');
  if (discounted !== undefined) session.amount_total = discounted;
  session.status = 'complete'; session.payment_status = session.amount_total === 0 ? 'no_payment_required' : 'paid';
  return session;
}
async function seed(id: number, key: PassPlanKey, left = 15, days = 30, amount: number = PAID_PLANS[key].priceCents, used = 0) {
  const purchase = (await pool.query(`INSERT INTO billing_purchases(user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid)
    VALUES($1,$2,$3,$4,$5) RETURNING id`, [id, `seed_${randomUUID()}`, key, PAID_PLANS[key].applications, amount])).rows[0].id;
  const end = new Date(now + left * DAY_MS).toISOString(), start = new Date(now - (days-left)*DAY_MS).toISOString();
  const grant = (await pool.query(`INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,credits_used,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`, [id,purchase,PAID_PLANS[key].applications,used,end,start])).rows[0].id;
  return { grant, end, purchase };
}

test('proration uses integer cents, the remaining period and the original sold duration', () => {
  const pass: ActivePass = { grantId: '1', planKey: 'essential-pass', expiresAt: new Date(now+15*DAY_MS).toISOString(),
    periodStartedAt: new Date(now-15*DAY_MS).toISOString(), priceCents: 990, durationMs: 30*DAY_MS, applications: 50 };
  const half = quoteCheckout('job-search-pass', pass, false, now);
  assert.equal(half.amountCents, 505); assert.equal(half.additionalApplications, 75); assert.equal(half.expiresAt, pass.expiresAt);
  assert.equal(quoteCheckout('job-search-pass', { ...pass, expiresAt: new Date(now+30*DAY_MS).toISOString() }, false, now).amountCents, 1009);
  assert.equal(quoteCheckout('job-search-pass', { ...pass, expiresAt: new Date(now+DAY_MS).toISOString() }, false, now).amountCents, 0, 'waive subminimum differences, never add a future charge');
  assert.equal(quoteCheckout('intensive-pass', { ...pass, planKey: 'job-search-pass', priceCents: 2499, durationMs: 60*DAY_MS, applications: 200, expiresAt: new Date(now+30*DAY_MS).toISOString() }, false, now).amountCents, 4750);
  assert.throws(() => quoteCheckout('essential-pass', pass, false, now), /already active/);
  assert.throws(() => quoteCheckout('essential-pass', { ...pass, planKey: 'job-search-pass' }, false, now), /downgrade/);
  assert.throws(() => quoteCheckout('job-search-pass', { ...pass, expiresAt: null }, false, now), /no expiry/);
  assert.throws(() => quoteCheckout('job-search-pass', { ...pass, expiresAt: new Date(now+20*60_000).toISOString() }, false, now), /too soon/);
  assert.ok(Object.values(billingOffers(null,true,now)).every(offer => offer.kind === 'blocked'));
});

test('one-time purchases reuse a checkout across tabs and grant only once across concurrent callbacks', async () => {
  const count = requests.length;
  const [first, second] = await Promise.all([checkout(2,'essential-pass'), checkout(2,'essential-pass')]);
  assert.equal(first.id, second.id); assert.equal(requests.length, count+1);
  const request = requests.at(-1)!;
  assert.equal(request.mode, 'payment'); assert.equal(request.payment_method_collection, undefined);
  assert.equal(request.subscription_data, undefined); assert.equal(request.payment_intent_data?.setup_future_usage, undefined);
  assert.equal('recurring' in request.line_items![0].price_data!, false);
  paid(first.id);
  const result = await Promise.all([fulfillPayment(pool,fake,first.id,'2'),fulfillPayment(pool,fake,first.id,'2')]);
  assert.equal(result.filter(value => value.fulfilled).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_purchases WHERE user_id=2')).rows[0].n, 1);
  await assert.rejects(checkout(2,'essential-pass'), /already active/);
});

test('upgrades preserve expiry and unused credits; a second upgrade uses the full target rate rather than the first gap payment', async () => {
  const source = await seed(1,'essential-pass',15,30,990,20);
  const active = await activeBillingPass(pool,'1');
  const offer = quoteCheckout('job-search-pass',active,false,now);
  const session = await checkout(1,'job-search-pass', { quotedAt: now, sourceGrantId: source.grant, amountCents: offer.amountCents, expiresAt: source.end });
  assert.equal(sessions.get(session.id)!.amount_total, 505);
  assert.equal(requests.at(-1)!.allow_promotion_codes, false);
  paid(session.id);
  const result = await fulfillPayment(pool,fake,session.id,'1');
  assert.equal(result.kind,'upgrade'); assert.equal(result.applications,75); assert.equal(result.expiresAt,source.end);
  const balances = (await pool.query('SELECT sum(credits_total-credits_used)::int AS n FROM application_credit_grants WHERE user_id=1')).rows[0].n;
  assert.equal(balances,105);
  const next = await activeBillingPass(pool,'1');
  assert.equal(next!.durationMs,30*DAY_MS); assert.equal(next!.priceCents,1999);
  const gold = quoteCheckout('intensive-pass',next,false,now);
  assert.equal(gold.amountCents,2000); assert.equal(gold.expiresAt,source.end);
  await assert.rejects(checkout(1,'essential-pass'),/downgrade/);
  await assert.rejects(checkout(1,'job-search-pass'),/already active/);
  const premium = await checkout(1,'intensive-pass', { quotedAt: now, sourceGrantId: next!.grantId, amountCents: gold.amountCents, expiresAt: gold.expiresAt });
  paid(premium.id); await fulfillPayment(pool,fake,premium.id,'1');
  const status = await billingStatus('1');
  assert.equal(status.paid.unlimitedApplications,true); assert.equal(status.paid.expiresAt,source.end);
  assert.ok(Object.values(status.offers!).every(value => value.kind === 'blocked'));
  const before = (await pool.query('SELECT credits_total FROM application_credit_grants WHERE purchase_id IN (SELECT id FROM billing_purchases WHERE user_id=1 AND purchase_kind=\'upgrade\') ORDER BY id')).rows;
  await pool.query(sql);
  assert.deepEqual((await pool.query('SELECT credits_total FROM application_credit_grants WHERE purchase_id IN (SELECT id FROM billing_purchases WHERE user_id=1 AND purchase_kind=\'upgrade\') ORDER BY id')).rows,before,'legacy backfill cannot refill prorated upgrade grants');
});

test('changing an unpaid selection expires the older link; paid but unconfirmed sessions block another payment', async () => {
  const old = await checkout(3,'essential-pass');
  const newer = await checkout(3,'job-search-pass');
  assert.equal(sessions.get(old.id)!.status,'expired');
  paid(newer.id);
  const count = requests.length;
  await assert.rejects(checkout(3,'intensive-pass'), /being confirmed/);
  assert.equal(requests.length,count);
  await fulfillPayment(pool,fake,newer.id,'3');
});

test('a lost Stripe response resumes the same persisted request and idempotency key', async () => {
  loseResponse = true;
  const count = requests.length;
  await assert.rejects(checkout(4,'essential-pass'), /lost the response/);
  const recovered = await checkout(4,'essential-pass');
  assert.ok(recovered.url); assert.equal(requests.length,count+1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_checkout_intents WHERE user_id=4')).rows[0].n,1);
});

test('a rejected provider request releases the pending slot so a corrected checkout can be created', async () => {
  rejectRequest = true;
  await assert.rejects(checkout(10,'essential-pass'), /invalid Stripe request/);
  assert.equal((await pool.query("SELECT state FROM billing_checkout_intents WHERE user_id=10")).rows[0].state,'failed');
  const corrected = await checkout(10,'essential-pass');
  assert.ok(corrected.url);
});

test('server rejects tampered, future, expired and stale quotes; an expired pass cannot silently turn a quoted upgrade into full price', async () => {
  const source = await seed(5,'essential-pass');
  const quote = quoteCheckout('job-search-pass',await activeBillingPass(pool,'5'),false,now);
  const count = requests.length;
  await assert.rejects(checkout(5,'job-search-pass',{ quotedAt: Date.now()+60_000 }), /expired/);
  await assert.rejects(checkout(5,'job-search-pass',{ quotedAt: now-11*60_000 }), /expired/);
  await assert.rejects(checkout(5,'job-search-pass',{ quotedAt: now, amountCents: 1 }), /changed/);
  await assert.rejects(checkout(5,'job-search-pass',{ quotedAt: now, sourceGrantId: '999' }), /changed/);
  await pool.query("UPDATE application_credit_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[source.grant]);
  await assert.rejects(checkout(5,'job-search-pass',{ quotedAt: now, sourceGrantId: source.grant, amountCents: quote.amountCents }), /changed/);
  assert.equal(requests.length,count);
  const fresh = await checkout(5,'job-search-pass'); assert.equal(sessions.get(fresh.id)!.amount_total,1999);
});

test('a paid upgrade invalidated by another grant is refunded once and never grants a stale or lower plan', async () => {
  await seed(6,'essential-pass');
  const upgrade = await checkout(6,'job-search-pass');
  await seed(6,'intensive-pass'); paid(upgrade.id);
  const count = refunds.size;
  const results = await Promise.all([fulfillPayment(pool,fake,upgrade.id,'6'),fulfillPayment(pool,fake,upgrade.id,'6')]);
  assert.ok(results.every(result => result.refunded)); assert.equal(refunds.size,count+1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_purchases WHERE user_id=6')).rows[0].n,2);
  assert.equal((await billingStatus('6')).paid.unlimitedApplications,true);
});

test('zero-cost remainder, discounted purchases and top-ups do not create recurring or extra charges', async () => {
  const source = await seed(7,'essential-pass',1);
  const upgrade = await checkout(7,'job-search-pass');
  assert.equal(sessions.get(upgrade.id)!.amount_total,0); paid(upgrade.id);
  const count = refunds.size;
  const result = await fulfillPayment(pool,fake,upgrade.id,'7');
  assert.equal(result.fulfilled,true); assert.equal(result.expiresAt,source.end); assert.equal(refunds.size,count);
  const discount = await checkout(8,'essential-pass'); paid(discount.id,790);
  await fulfillPayment(pool,fake,discount.id,'8');
  assert.equal((await activeBillingPass(pool,'8'))!.priceCents,790,'credit the actual paid value rather than a fictional full-price payment');
  const topup = await managedCheckout(pool,fake,user(8),'application-top-up',false,env);
  paid(topup.id); const expiry = (await activeBillingPass(pool,'8'))!.expiresAt;
  assert.equal((await fulfillPayment(pool,fake,topup.id,'8')).expiresAt,expiry);
});

test('legacy payments retain their sold duration, but an old duplicate or downgrade link is refunded; another owner cannot fulfill a purchase', async () => {
  const id = `cs_legacy_${randomUUID()}`;
  sessions.set(id, { id, mode: 'payment', subscription: null, livemode: false, status: 'complete', payment_status: 'paid',
    metadata: { userId: '9', planKey: 'job-search-pass' }, amount_total: 2499, amount_subtotal: 2499, currency:'aud', payment_intent:`pi_${id}`, created:Math.floor(now/1000) } as unknown as Stripe.Checkout.Session);
  await assert.rejects(fulfillPayment(pool,fake,id,'10'), /another account/);
  const legacy = await fulfillPayment(pool,fake,id,'9'); assert.equal(legacy.durationDays,60);
  const duplicate = `cs_legacy_${randomUUID()}`;
  sessions.set(duplicate,{ ...sessions.get(id)!,id:duplicate,payment_intent:`pi_${duplicate}`,metadata:{userId:'9',planKey:'essential-pass',durationDays:'30'}});
  assert.equal((await fulfillPayment(pool,fake,duplicate,'9')).refunded,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_purchases WHERE user_id=9')).rows[0].n,1);
});
