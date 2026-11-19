import { adminAddresses } from '../admin-access.js';
import { query } from '../db/index.js';

export const HR_OUTREACH_ACCESS_MESSAGE = 'Employer emails are available with an active Get Owtomated pass.';

/** The caller joins the account as u and supplies the current admin addresses.
 * Use the active pass grant, not the credit balance or the user's saved opt-in. */
export function hrOutreachEligibleSql(admins: '$1' | '$2' | '$3' | '$4'): string {
  return `(lower(trim(u.email))=ANY(${admins}::text[]) OR EXISTS (
    SELECT 1 FROM application_credit_grants g
    JOIN billing_purchases purchase ON purchase.id=g.purchase_id AND purchase.user_id=g.user_id
    WHERE g.user_id=u.id AND purchase.plan_key='intensive-pass'
      AND (g.expires_at IS NULL OR g.expires_at>now())
  ))`;
}

const database = { query: async (sql: string, params: unknown[]) => ({ rows: await query(sql, params) }) };

export async function hrOutreachAllowed(userId: string, db = database): Promise<boolean> {
  const { rows } = await db.query(`SELECT u.id FROM users u
    WHERE u.id=$1 AND u.blocked_at IS NULL AND ${hrOutreachEligibleSql('$2')}`, [userId, adminAddresses()]);
  return rows.length > 0;
}
