/** Read-only by default. Optionally retire unpaid pre-upgrade app checkout links. */
import Stripe from 'stripe';
import { readEnv } from '../server/runner.js';
import { getPool } from '../server/db/index.js';
import { isPaidPlanKey } from '../src/pricing.js';

const env = readEnv();
const mode = (process.env.STRIPE_MODE ?? env.STRIPE_MODE ?? '').trim().toLowerCase() === 'test' ? 'test' : 'live';
const keyName = mode === 'test' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
const key = (process.env[keyName] ?? env[keyName] ?? '').trim();
if (!key || (mode === 'live' && !/^[sr]k_live_/.test(key)) || (mode === 'test' && !/^[sr]k_test_/.test(key))) throw new Error('The selected Stripe mode is not configured correctly.');
const stripe = new Stripe(key, { timeout: 10_000, maxNetworkRetries: 1 });
const recurring: Record<string, number> = {};
for await (const subscription of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
  recurring[subscription.status] = (recurring[subscription.status] ?? 0) + 1;
}
let legacyOpen = 0, retired = 0, managedOpen = 0, retiredUpgrades = 0;
const pool = getPool();
try {
  for await (const session of stripe.checkout.sessions.list({ status: 'open', limit: 100 })) {
    const userId = session.metadata?.userId;
    if (session.mode !== 'payment' || !userId || !/^\d+$/.test(userId) || !isPaidPlanKey(session.metadata?.planKey)) continue;
    const owner = await pool.query('SELECT 1 FROM users WHERE id=$1', [userId]);
    if (!owner.rowCount) continue;
    if (session.metadata?.checkoutIntentId) {
      managedOpen++;
      if (process.argv.includes('--expire-old-upgrades')) {
        const intent = (await pool.query(`SELECT id,quote FROM billing_checkout_intents
          WHERE id::text=$1 AND user_id=$2 AND plan_key=$3 AND stripe_mode=$4
            AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id=$5)
            AND state IN ('creating','open','processing')`,
        [session.metadata.checkoutIntentId,userId,session.metadata.planKey,mode,session.id])).rows[0];
        if (intent?.quote.kind === 'upgrade' && intent.quote.upgradePricingVersion !== 2) {
          try {
            await stripe.checkout.sessions.expire(session.id);
            await pool.query("UPDATE billing_checkout_intents SET state='expired',stripe_checkout_session_id=$2 WHERE id=$1 AND state IN ('creating','open','processing')", [intent.id,session.id]);
            retiredUpgrades++;
          } catch { console.error('An upgrade checkout changed during retirement; rerun the audit.'); }
        }
      }
      continue;
    }
    legacyOpen++;
    if (process.argv.includes('--expire-legacy')) {
      try { await stripe.checkout.sessions.expire(session.id); retired++; }
      catch { console.error('A legacy checkout changed during retirement; rerun the audit.'); }
    }
  }
  console.log(JSON.stringify({ mode, recurringSubscriptionsByStatus: recurring, legacyOpenCheckouts: legacyOpen, retiredLegacyCheckouts: retired,
    managedOpenCheckouts: managedOpen, retiredUpgradeCheckouts: retiredUpgrades }));
} finally { await pool.end(); }
