import type { PoolClient } from 'pg';
import { FREE_APPLICATIONS } from '../src/pricing.js';

/** Caller owns the transaction. The account lock serializes every credit deduction. */
export async function consumeApplicationCredit(client: PoolClient, userId: string, external = false): Promise<void> {
  // One account at a time through this check, so two runs cannot both take the last free application.
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);

  let employerGrantId: string | null = null;
  if (external) {
    const employerGrant = await client.query<{ id: string }>(
      `SELECT id
         FROM employer_site_credit_grants
        WHERE user_id = $1
          AND (expires_at IS NULL OR expires_at > now())
          AND credits_used < credits_total
        ORDER BY expires_at NULLS LAST, id
        LIMIT 1
        FOR UPDATE`,
      [userId],
    );
    employerGrantId = employerGrant.rows[0]?.id ?? null;
    if (!employerGrantId) throw new Error('No employer-site application allowance remains.');
  }
  const usage = await client.query<{ used: string }>(
    `SELECT COALESCE(sum(successful_applications), 0)::text AS used
       FROM monthly_application_usage
      WHERE user_id = $1`,
    [userId],
  );
  if (!external && Number(usage.rows[0]?.used ?? 0) < FREE_APPLICATIONS) {
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
        WHERE user_id = $1
          AND (expires_at IS NULL OR expires_at > now())
          AND credits_used < credits_total
        ORDER BY expires_at NULLS LAST, id
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
  if (employerGrantId) {
    await client.query(
      `UPDATE employer_site_credit_grants
          SET credits_used = credits_used + 1
        WHERE id = $1`,
      [employerGrantId],
    );
  }
}
