import {one} from './db/index.js';
import {isAdmin} from './admin-access.js';
import {planDailyApplicationLimit} from '../src/pricing.js';

/** Read-only send-boundary policy, independent of Stripe and billing startup. */
export async function accountDailyApplicationLimit(userId:string):Promise<number> {
  const row=await one<{email:string;active_search:boolean;intensive:boolean}>(`SELECT u.email,
    EXISTS(SELECT 1 FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
      WHERE g.user_id=u.id AND p.plan_key='job-search-pass' AND (g.expires_at IS NULL OR g.expires_at>now())) AS active_search,
    EXISTS(SELECT 1 FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
      WHERE g.user_id=u.id AND p.plan_key='intensive-pass' AND (g.expires_at IS NULL OR g.expires_at>now())) AS intensive
    FROM users u WHERE u.id=$1`,[userId]);
  if(!row)throw new Error('Account is unavailable.');
  return planDailyApplicationLimit({hasActiveJobSearchPass:row.active_search,hasActiveIntensivePass:row.intensive},isAdmin(row.email));
}
