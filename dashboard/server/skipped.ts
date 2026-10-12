import { query } from './db/index.js';

/**
 * Jobs the fit check skipped, with its reason, and the candidate's own call on
 * each — the Skipped view.
 *
 * The check skips most of what it reviews (79–92% for the busiest accounts)
 * and the candidate never saw one of them, so a judge reading "5+ years" or
 * "mandatory" too strictly could only reinforce itself. Here the candidate
 * can read the listing and say "I would have applied" — the job goes back
 * into the next run as their choice and the fit check is shown the call — or
 * "Right call", which tells it the reading was sound.
 *
 * Read from `run_events`: only fit decisions (a skip, an uncertain verdict, a
 * score under the account's minimum), the latest per job, from the last two
 * weeks, and never one the account has since applied to.
 */

export type SkipKind = 'rules' | 'fit' | 'uncertain' | 'score';
export type Verdict = 'apply' | 'skip';

export interface SkippedJob {
  jobId: string;
  title: string;
  company: string;
  kind: SkipKind;
  reason: string;
  url: string;
  at: string;
  verdict: Verdict | null;
  note: string | null;
}

const WINDOW_DAYS = 14;
const FIT_SKIP = `(reason LIKE 'Fit check (%' OR reason LIKE 'Model match score %')`;

/** The listing's address; older events did not record it, so it is rebuilt from the board's own id. */
export function listingUrl(jobId: string, recorded: string | null): string {
  if (recorded) return recorded;
  if (/^\d{6,12}$/.test(jobId)) return `https://www.seek.com.au/job/${jobId}`;
  if (/^[0-9a-f]{16}$/i.test(jobId)) return `https://au.indeed.com/viewjob?jk=${jobId}`;
  return '';
}

export function skipKind(reason: string): SkipKind {
  if (/^Model match score /.test(reason)) return 'score';
  if (/Your instructions rule this out/.test(reason)) return 'rules';
  if (/^Fit check \(uncertain\)/.test(reason)) return 'uncertain';
  return 'fit';
}

/** The check's own words, without the log's "Fit check (skip):" prefix. */
export function skipText(reason: string): string {
  return reason.replace(/^Fit check \((?:skip|uncertain)\):\s*/, '').trim();
}

export async function loadSkipped(userId: string): Promise<SkippedJob[]> {
  const rows = await query<{
    job_id: string; title: string | null; company: string | null; reason: string; url: string | null; ts: Date | string;
    verdict: Verdict | null; note: string | null;
  }>(
    `SELECT latest.job_id, latest.title, latest.company, latest.reason, latest.url, latest.ts, v.verdict, v.note
       FROM (
         SELECT DISTINCT ON (job_id) id, job_id, status, title, company, reason, url, ts
           FROM run_events
          WHERE user_id = $1 AND job_id IS NOT NULL AND ts > now() - make_interval(days => $2)
          ORDER BY job_id, ts DESC, id DESC
       ) AS latest
       LEFT JOIN review_verdicts v ON v.user_id = $1 AND v.job_id = latest.job_id
      WHERE latest.status = 'skipped' AND ${FIT_SKIP.replace(/reason/g, 'latest.reason')}
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = $1 AND a.job_id = latest.job_id)
      ORDER BY latest.ts DESC
      LIMIT 500`,
    [userId, WINDOW_DAYS],
  );
  return rows.map((row) => ({
    jobId: row.job_id,
    title: row.title ?? 'Untitled role',
    company: row.company ?? '',
    kind: skipKind(row.reason),
    reason: skipText(row.reason),
    url: listingUrl(row.job_id, row.url),
    at: new Date(row.ts).toISOString(),
    verdict: row.verdict,
    note: row.note,
  }));
}

/**
 * Records, changes or (with a null verdict) withdraws the candidate's call on
 * one skipped job. What the job was and why it was skipped come from the run's
 * own record, not from the request.
 */
export async function setVerdict(userId: string, jobId: string, verdict: Verdict | null, note?: string): Promise<{ ok: boolean; error?: string }> {
  if (!jobId || jobId.length > 64) return { ok: false, error: 'Unknown job.' };
  if (verdict === null) {
    await query(`DELETE FROM review_verdicts WHERE user_id = $1 AND job_id = $2`, [userId, jobId]);
    return { ok: true };
  }
  if (verdict !== 'apply' && verdict !== 'skip') return { ok: false, error: 'Unknown verdict.' };
  const event = await query<{ title: string | null; company: string | null; reason: string; url: string | null }>(
    `SELECT title, company, reason, url FROM run_events
      WHERE user_id = $1 AND job_id = $2 AND status = 'skipped' AND ${FIT_SKIP}
      ORDER BY ts DESC LIMIT 1`,
    [userId, jobId],
  );
  const skipped = event[0];
  if (!skipped) return { ok: false, error: 'That job is not in your skipped list.' };
  const text = (note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  await query(
    `INSERT INTO review_verdicts (user_id, job_id, title, company, url, skip_reason, verdict, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, job_id) DO UPDATE SET
       verdict = EXCLUDED.verdict, note = EXCLUDED.note, created_at = now()`,
    [userId, jobId, skipped.title, skipped.company, listingUrl(jobId, skipped.url), skipText(skipped.reason), verdict, text],
  );
  return { ok: true };
}

/**
 * The verdicts a run takes with it (seek-bot review-verdicts.ts): the last
 * month's, newest first, leaving out jobs since applied to.
 */
export async function verdictsForRun(userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{
    job_id: string; title: string | null; company: string | null; url: string | null;
    skip_reason: string | null; verdict: Verdict; note: string | null; created_at: Date | string;
  }>(
    `SELECT v.job_id, v.title, v.company, v.url, v.skip_reason, v.verdict, v.note, v.created_at
       FROM review_verdicts v
      WHERE v.user_id = $1 AND v.created_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = $1 AND a.job_id = v.job_id)
      ORDER BY v.created_at DESC
      LIMIT 50`,
    [userId],
  );
  return rows.map((row) => ({
    jobId: row.job_id,
    title: row.title ?? '',
    company: row.company ?? '',
    ...(row.url ? { url: row.url } : {}),
    skipReason: row.skip_reason ?? '',
    verdict: row.verdict,
    ...(row.note ? { note: row.note } : {}),
    at: new Date(row.created_at).toISOString(),
  }));
}
