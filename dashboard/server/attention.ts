import { query } from './db/index.js';
import type { BlockedQuestion } from '../../seek-bot/src/types.js';
import { normaliseBlockedQuestions as normaliseQuestions } from '../../seek-bot/src/blocked-questions.js';
export { normaliseQuestions };
import { plainReason } from '../src/run-messages.js';
export { plainReason } from '../src/run-messages.js';

/**
 * Everything a run could not finish on its own — Postgres-backed and scoped
 * to one account. Used to read the single shared `seek-bot/data/run-log.jsonl`
 * regardless of who was signed in; now reads `run_events` (synced per-run by
 * `db/run-sync.ts`) and `applications`, both filtered by `user_id`.
 */

type AttentionKind = 'question';

interface AttentionItem {
  jobId: string;
  title: string;
  company: string;
  kind: AttentionKind;
  reason: string;
  url: string;
  at: string;
  /** Questions the candidate can answer right here to unblock the job. */
  questions?: BlockedQuestion[];
}

export interface RunEventRow {
  job_id: string | null;
  status: string;
  title: string | null;
  company: string | null;
  reason: string | null;
  url: string | null;
  ts: Date | string;
  questions: unknown[] | null;
}

const ATTENTION_STATUSES = new Set(['needs-human']);
const RESOLVED_STATUSES = ['answered', 'prepared', 'rehearsed', 'applied', 'already-applied'];

/**
 * Questions remain until answered, dismissed or a completed application
 * resolves them. An unsuccessful technical retry cannot answer a question.
 */
export function resolveAttention(events: RunEventRow[], applied: ReadonlySet<string>): AttentionItem[] {
  const latest = new Map<string, AttentionItem>();

  for (const e of [...events].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)))) {
    if (!e.job_id || applied.has(e.job_id)) continue;
    if (RESOLVED_STATUSES.includes(e.status)) {
      latest.delete(e.job_id);
      continue;
    }
    if (!ATTENTION_STATUSES.has(e.status)) continue;

    const reason = e.reason ?? 'stopped';
    const questions = normaliseQuestions(e.questions);
    // Only an exact, unanswered required application question creates a user
    // task. Authentication, CAPTCHA, navigation and provider failures remain
    // run outcomes and never enter Needs attention.
    if (!questions.length) {
      continue;
    }

    // Later entries win: a job may have been retried and resolved differently.
    latest.set(e.job_id, {
      jobId: e.job_id,
      title: e.title ?? `Job ${e.job_id}`,
      company: e.company ?? '-',
      kind: 'question',
      reason: plainReason(String(reason)).slice(0, 300),
      url: e.url ?? `https://www.seek.com.au/job/${e.job_id}`,
      at: new Date(e.ts).toISOString(),
      ...(questions.length ? { questions } : {}),
    });
  }

  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function loadAttention(userId: string, read: typeof query = query): Promise<AttentionItem[]> {
  const [events, appliedRows] = await Promise.all([
    read<RunEventRow>(
      `SELECT job_id, status, title, company, reason, url, ts, questions
         FROM (
           SELECT DISTINCT ON (job_id)
                  id, job_id, status, title, company, reason, url, ts, questions, dismissed_at
             FROM run_events
            WHERE user_id = $1 AND job_id IS NOT NULL
              AND (status = ANY($2::text[]) OR (status = 'needs-human'
                AND CASE WHEN jsonb_typeof(questions) = 'array'
                  THEN jsonb_array_length(questions) > 0 ELSE false END))
            ORDER BY job_id, ts DESC, id DESC
         ) AS latest
        WHERE dismissed_at IS NULL
        ORDER BY ts`,
      [userId, RESOLVED_STATUSES],
    ),
    read<{ job_id: string }>(`SELECT job_id FROM applications WHERE user_id = $1`, [userId]),
  ]);
  return resolveAttention(events, new Set(appliedRows.map((row) => row.job_id)));
}

/**
 * Clears this account's "Needs attention" list.
 *
 * Marks rather than deletes: `run_events` is the record of what runs actually
 * did, and a blocker the user has read and moved on from is still part of that
 * history. A later run that hits the same job logs a fresh event, so a
 * dismissed item comes back if it genuinely recurs.
 */
export async function dismissAllAttention(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE run_events
        SET dismissed_at = now()
      WHERE user_id = $1
        AND status = 'needs-human'
        AND dismissed_at IS NULL
      RETURNING id`,
    [userId],
  );
  return rows.length;
}
