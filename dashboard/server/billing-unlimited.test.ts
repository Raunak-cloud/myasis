import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import Stripe from 'stripe';
import { getPool } from './db/index.js';
import { billingStatus, checkoutPriceData, checkoutDurationDays, createCheckout, handleStripeWebhook } from './billing.js';
import { PAID_PLANS } from '../src/pricing.js';
import { consumeApplicationCredit } from './application-credits.js';
import { saveApplicationReview } from './application-reviews.js';

const pool = getPool();
const schema = `unlimited_test_${randomUUID().replaceAll('-', '')}`;
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });
before(async () => {
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE users(id bigint PRIMARY KEY,email text NOT NULL);
    INSERT INTO users VALUES (1,'unlimited@fixture.invalid'),(2,'finite@fixture.invalid'),(3,'active@fixture.invalid'),(4,'checkout@fixture.invalid');`);
  const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  for (const table of ['billing_purchases', 'billing_checkout_intents', 'application_credit_grants', 'employer_site_credit_grants', 'monthly_application_usage', 'application_reviews']) {
    await pool.query(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  }
});

test('Stripe products charge AUD19.99 and AUD59.99 once for 30 days', () => {
  const active = checkoutPriceData('job-search-pass');
  assert.equal(active.currency, 'aud'); assert.equal(active.unit_amount, 1999);
  assert.equal(active.tax_behavior, 'inclusive');
  assert.equal(PAID_PLANS['job-search-pass'].durationDays, 30);
  assert.match(active.product_data.description, /200 application credits.*30 days.*no automatic renewal/);
  const price = checkoutPriceData('intensive-pass');
  assert.equal(price.currency, 'aud'); assert.equal(price.unit_amount, 5999);
  assert.equal(price.tax_behavior, 'inclusive', 'tax must not increase the advertised checkout amount');
  assert.equal(price.product_data.name, 'Get Owtomated');
  assert.equal(PAID_PLANS['intensive-pass'].durationDays, 30);
  assert.match(price.product_data.description, /Unlimited applications.*30 days.*no automatic renewal/);
  assert.doesNotMatch(price.product_data.description, /400/);
});

test('checkout access periods survive pricing changes and legacy pending payments keep 60 days', () => {
  for (const key of ['job-search-pass', 'intensive-pass'] as const) {
    assert.equal(checkoutDurationDays(key, { durationDays: String(PAID_PLANS[key].durationDays) }), 30);
    assert.equal(checkoutDurationDays(key, { durationDays: '45' }), 45, 'honor the term snapshotted when checkout opened');
    assert.equal(checkoutDurationDays(key, { userId: '1', planKey: key }), 60, 'an older checkout retains its sold term');
    assert.throws(() => checkoutDurationDays(key, { durationDays: 'invalid' }), /Invalid checkout access period/);
  }
  assert.equal(checkoutDurationDays('essential-pass', null), 30);
  assert.equal(checkoutDurationDays('application-top-up', null), 0);
});

test('new checkout requests carry the advertised amount and snapshot 30 days for fulfillment', async t => {
  const keys = ['STRIPE_MODE', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_WEBHOOK_SECRET'] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }));
  process.env.STRIPE_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_offline_fixture';
  process.env.STRIPE_TEST_WEBHOOK_SECRET = 'whsec_offline_fixture';
  const requests: Stripe.Checkout.SessionCreateParams[] = [];
  const sessions = new Stripe('sk_test_offline_fixture').checkout.sessions;
  t.mock.method(Object.getPrototypeOf(sessions), 'create', async (params: Stripe.Checkout.SessionCreateParams) => {
    requests.push(params);
    return { id: `cs_test_${params.metadata?.checkoutIntentId}`, url: 'https://checkout.stripe.com/offline-fixture' };
  });
  for (const [key, amount] of [['job-search-pass', 1999], ['intensive-pass', 5999]] as const) {
    await createCheckout({ id: key === 'job-search-pass' ? '3' : '4', email: 'checkout@fixture.invalid' } as Parameters<typeof createCheckout>[0], key);
    const request = requests.at(-1)!;
    assert.equal(request.mode, 'payment');
    assert.equal(request.line_items?.[0].price_data?.unit_amount, amount);
    assert.equal(request.line_items?.[0].price_data?.tax_behavior, 'inclusive');
    assert.equal(request.metadata?.durationDays, '30');
    assert.equal(request.payment_intent_data?.metadata?.durationDays, '30');
    assert.equal(checkoutDurationDays(key, request.metadata as Record<string, string>), 30);
  }
});

test('signed delayed-payment webhooks reserve checkout while processing and release failed or expired requests', async t => {
  const names = ['STRIPE_MODE','STRIPE_TEST_SECRET_KEY','STRIPE_TEST_WEBHOOK_SECRET'] as const;
  const previous = names.map(key => process.env[key]);
  t.after(() => names.forEach((key,index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  process.env.STRIPE_MODE = 'test'; process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_offline_fixture';
  process.env.STRIPE_TEST_WEBHOOK_SECRET = 'whsec_offline_fixture';
  const id = randomUUID();
  await pool.query(`INSERT INTO billing_checkout_intents(id,user_id,plan_key,stripe_mode,quote,stripe_params,expires_at)
    VALUES($1,2,'essential-pass','test','{}','{}',now()+interval '31 minutes')`, [id]);
  const session = { id: 'cs_async_fixture', mode: 'payment', livemode: false, payment_status: 'unpaid',
    metadata: { userId: '2',planKey: 'essential-pass',checkoutIntentId: id } };
  const deliver = async (type: string, object = session) => {
    const payload = JSON.stringify({ id: 'evt_fixture',object: 'event',type,data: { object } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload,secret: 'whsec_offline_fixture' });
    await handleStripeWebhook(Buffer.from(payload),signature);
  };
  const state = async () => (await pool.query('SELECT state FROM billing_checkout_intents WHERE id=$1',[id])).rows[0].state;
  await deliver('checkout.session.completed'); assert.equal(await state(),'processing');
  await deliver('checkout.session.async_payment_failed'); assert.equal(await state(),'failed');
  await deliver('checkout.session.completed'); assert.equal(await state(),'failed','a repeated older completed event cannot reserve a failed checkout again');
  await pool.query("UPDATE billing_checkout_intents SET state='open' WHERE id=$1",[id]);
  await deliver('checkout.session.expired',{ ...session,metadata:{ ...session.metadata,userId:'1' } });
  assert.equal(await state(),'open','an event for another owner cannot release the pending slot');
  await deliver('checkout.session.expired'); assert.equal(await state(),'expired');
});

test('real DB: unlimited includes preparation and employer forms, preserves finite credits, is owner scoped and expires', async () => {
  const purchase = (await pool.query(`INSERT INTO billing_purchases(user_id,stripe_checkout_session_id,plan_key,applications_granted,amount_paid)
    VALUES(1,'fixture-unlimited','intensive-pass',400,7999) RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO application_credit_grants(user_id,purchase_id,credits_total,credits_used,expires_at)
    VALUES(1,$1,400,400,now()+interval '60 days')`, [purchase]);
  // Exhausted historical balances still receive unlimited access for their remaining pass duration.
  const before = await billingStatus('1');
  assert.equal(before.paid.unlimitedApplications, true); assert.ok(before.totalRemaining > 0);
  assert.equal((await billingStatus('2')).paid.unlimitedApplications, false);
  const client = await pool.connect();
  try {
    for (const external of [false, true]) {
      await client.query('BEGIN'); await consumeApplicationCredit(client, '1', external); await client.query('COMMIT');
    }
    const prepared = {
      id: randomUUID(), revision: 'a'.repeat(64),
      job: { id: 'fixture-unlimited', title: 'Fixture developer', company: 'Fictional Employer', location: 'Sydney', url: 'https://fixture.invalid/job', platform: 'seek' as const },
      preparedAt: new Date().toISOString(), formUrl: 'https://www.seek.com.au/job/123/apply/review',
      answers: [{ question: 'Name', answer: 'Fixture Applicant' }], resume: 'Fixture CV.pdf',
    };
    await saveApplicationReview('1', prepared);
    assert.equal((await pool.query('SELECT credit_consumed FROM application_reviews WHERE user_id=1')).rows[0].credit_consumed, true);
    assert.equal((await pool.query('SELECT credits_used FROM application_credit_grants WHERE user_id=1')).rows[0].credits_used, 400);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM monthly_application_usage WHERE user_id=1')).rows[0].n, 0);
    await assert.rejects(createCheckout({ id: '1', email: 'unlimited@fixture.invalid' } as Parameters<typeof createCheckout>[0], 'application-top-up'), /already includes unlimited/);
    await pool.query("UPDATE application_credit_grants SET expires_at=now()-interval '1 second' WHERE user_id=1");
    assert.equal((await billingStatus('1')).paid.unlimitedApplications, false);
    await client.query('BEGIN'); await consumeApplicationCredit(client, '1'); await client.query('COMMIT');
    assert.equal((await pool.query('SELECT successful_applications FROM monthly_application_usage WHERE user_id=1')).rows[0].successful_applications, 1, 'expiry falls back to the finite allowance');
    // Another account never inherits unlimited access.
    await client.query('BEGIN'); await consumeApplicationCredit(client, '2'); await client.query('COMMIT');
    assert.equal((await pool.query('SELECT successful_applications FROM monthly_application_usage WHERE user_id=2')).rows[0].successful_applications, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
