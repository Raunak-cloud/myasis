import { query } from './db/index.js';
import { isSiteSecurityFailure, securityRetryAt } from '../src/securityRetry.js';

/** Add policy state to existing failures once, using the original event time.
 * This never edits the outcome, draft, approval, billing or audit history. */
export async function backfillSecurityRetryCooldowns(): Promise<number> {
  const rows = await query<{ user_id: string; id: string; detail: string; updated_version: string; blocked_at: Date }>(
    `SELECT r.user_id::text,r.id::text,r.detail,r.updated_at::text AS updated_version,COALESCE(e.ts,r.updated_at) AS blocked_at
       FROM application_reviews r LEFT JOIN LATERAL (
         SELECT max(ts) AS ts FROM run_events WHERE user_id=r.user_id
           AND job_id=r.payload->'job'->>'id' AND reason=r.detail AND status IN ('skipped','error','needs-human')
       ) e ON true
      WHERE r.status='failed' AND r.detail IS NOT NULL AND r.security_retry_after IS NULL`);
  let updated = 0;
  for (const row of rows) {
    if (!isSiteSecurityFailure(row.detail)) continue;
    const retryAt = securityRetryAt(row.blocked_at);
    if (!retryAt) continue;
    const result = await query(`UPDATE application_reviews SET security_retry_after=$5
      WHERE user_id=$1 AND id=$2 AND status='failed' AND detail=$3 AND updated_at=$4::timestamptz
        AND security_retry_after IS NULL RETURNING id`, [row.user_id,row.id,row.detail,row.updated_version,retryAt]);
    updated += result.length;
  }
  return updated;
}
