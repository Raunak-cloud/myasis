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
let legacyOpen = 0, retired = 0, managedOpen = 0;
const pool = getPool();
try {
  for await (const session of stripe.checkout.sessions.list({ status: 'open', limit: 100 })) {
    const userId = session.metadata?.userId;
    if (session.mode !== 'payment' || !userId || !/^\d+$/.test(userId) || !isPaidPlanKey(session.metadata?.planKey)) continue;
    const owner = await pool.query('SELECT 1 FROM users WHERE id=$1', [userId]);
    if (!owner.rowCount) continue;
    if (session.metadata?.checkoutIntentId) { managedOpen++; continue; }
    legacyOpen++;
    if (process.argv.includes('--expire-legacy')) {
      try { await stripe.checkout.sessions.expire(session.id); retired++; }
      catch { console.error('A legacy checkout changed during retirement; rerun the audit.'); }
    }
  }
  console.log(JSON.stringify({ mode, recurringSubscriptionsByStatus: recurring, legacyOpenCheckouts: legacyOpen, retiredLegacyCheckouts: retired, managedOpenCheckouts: managedOpen }));
} finally { await pool.end(); }
