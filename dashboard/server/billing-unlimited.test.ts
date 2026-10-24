import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { getPool } from './db/index.js';
import { billingStatus, checkoutPriceData, createCheckout } from './billing.js';
import { consumeApplicationCredit } from './application-credits.js';
import { saveApplicationReview } from './application-reviews.js';

const pool = getPool();
const schema = `unlimited_test_${randomUUID().replaceAll('-', '')}`;
(pool as unknown as { options: { options: string } }).options.options = `-c search_path=${schema}`;
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

test('Stripe product is AUD79.99 once, with unlimited applications and 60 days', () => {
  const price = checkoutPriceData('intensive-pass');
  assert.equal(price.currency, 'aud'); assert.equal(price.unit_amount, 7999);
  assert.equal(price.product_data.name, 'Get Owtomated');
  assert.match(price.product_data.description, /Unlimited applications.*60 days.*no automatic renewal/);
  assert.doesNotMatch(price.product_data.description, /400/);
});

test('real DB: unlimited includes preparation and employer forms, preserves finite credits, is owner scoped and expires', async () => {
  await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE users(id bigint PRIMARY KEY,email text NOT NULL);
    INSERT INTO users VALUES (1,'unlimited@fixture.invalid'),(2,'finite@fixture.invalid');`);
  const sql = readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
  for (const table of ['billing_purchases', 'application_credit_grants', 'employer_site_credit_grants', 'monthly_application_usage', 'application_reviews']) {
    await pool.query(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  }
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
