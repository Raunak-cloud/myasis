import { query } from './db/index.js';

interface ReviewCacheExportRow {
  job_id: string;
  title: string | null;
  company: string | null;
  reason: string | null;
  ts: Date | string;
  review_disposition: string;
  review_listing_fingerprint: string | null;
  review_context_fingerprint: string | null;
  review_expires_at: Date | string | null;
  review_content_fingerprint?: string | null;
}


/** Durable, account-scoped suitability memory plus short-lived external skips. */
export async function loadReviewMemory(userId: string) {
  const reviewCache = await query<ReviewCacheExportRow>(
    `SELECT job_id, title, company, reason, reviewed_at AS ts, disposition AS review_disposition,
            listing_fingerprint AS review_listing_fingerprint, context_fingerprint AS review_context_fingerprint,
            content_fingerprint AS review_content_fingerprint, NULL::timestamptz AS review_expires_at
       FROM job_review_decisions WHERE user_id = $1
        AND job_id NOT IN (SELECT job_id FROM review_verdicts WHERE user_id = $1 AND verdict = 'apply')
      UNION ALL
      SELECT job_id, title, company, reason, ts, review_disposition,
            review_listing_fingerprint, review_context_fingerprint, review_content_fingerprint, review_expires_at
       FROM run_events
      WHERE user_id = $1 AND job_id IS NOT NULL
        AND review_disposition = 'external' AND review_expires_at > now()
        -- A skip the candidate overruled is reviewed again, as their choice.
        AND job_id NOT IN (SELECT job_id FROM review_verdicts WHERE user_id = $1 AND verdict = 'apply')
      ORDER BY ts DESC`,
    [userId],
  );
  // Safely reuse old off-platform decisions immediately. They need no
  // candidate-context fingerprint and expire seven days after the event.
  const legacyExternal = await query<ReviewCacheExportRow>(
    `SELECT job_id, title, company, reason, ts, 'external' AS review_disposition,
            NULL::text AS review_listing_fingerprint, NULL::text AS review_context_fingerprint,
            ts + interval '7 days' AS review_expires_at
       FROM run_events
      WHERE user_id = $1 AND job_id IS NOT NULL AND status = 'off-platform'
        AND review_disposition IS NULL AND ts > now() - interval '7 days'
      ORDER BY ts DESC LIMIT 2000`,
    [userId],
  );
  return [...reviewCache, ...legacyExternal].map(row => ({
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    reason: row.reason ?? row.review_disposition,
    reviewedAt: new Date(row.ts).toISOString(),
    disposition: row.review_disposition,
    ...(row.review_listing_fingerprint ? { listingFingerprint: row.review_listing_fingerprint } : {}),
    ...(row.review_context_fingerprint ? { contextFingerprint: row.review_context_fingerprint } : {}),
    ...(row.review_content_fingerprint ? { contentFingerprint: row.review_content_fingerprint } : {}),
    expiresAt: row.review_expires_at === null ? null : new Date(row.review_expires_at).toISOString(),
  }));
}
