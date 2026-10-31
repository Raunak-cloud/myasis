import { query } from './db/index.js';
import type { BlockedQuestion } from '../../seek-bot/src/types.js';
import { normaliseBlockedQuestions as normaliseQuestions } from '../../seek-bot/src/blocked-questions.js';
import { blockedQuestionKey } from '../../seek-bot/src/blocked-questions.js';
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
  id?: string | number;
  /** PostgreSQL timestamp precision, retained before pg converts ts to a millisecond Date. */
  order_at?: string;
  job_id: string | null;
  status: string;
  title: string | null;
  company: string | null;
  reason: string | null;
  url: string | null;
  ts: Date | string;
  questions: unknown;
  dismissed_at?: Date | string | null;
}

const ATTENTION_STATUSES = new Set(['needs-human']);
const RESOLVED_STATUSES = ['answered', 'prepared', 'rehearsed', 'applied', 'already-applied'];

function eventOrder(event: RunEventRow): bigint {
  return event.order_at === undefined ? BigInt(new Date(event.ts).getTime()) * 1000n : BigInt(event.order_at);
}

/**
 * Questions remain until answered, dismissed or a completed application
 * resolves them. An unsuccessful technical retry cannot answer a question.
 */
export function resolveAttention(events: RunEventRow[], applied: ReadonlySet<string>): AttentionItem[] {
  const latest = new Map<string, AttentionItem>();
  const dismissedThrough = new Map<string, number>();
  for (const event of events) {
    if (event.job_id && event.status === 'needs-human' && event.dismissed_at) {
      const boundary = Math.max(new Date(event.ts).getTime(), new Date(event.dismissed_at).getTime());
      if (Number.isFinite(boundary)) dismissedThrough.set(event.job_id, Math.max(boundary, dismissedThrough.get(event.job_id) ?? -Infinity));
    }
  }

  for (const e of events.filter(event => Number.isFinite(new Date(event.ts).getTime())).sort((a, b) => (eventOrder(a) < eventOrder(b) ? -1 : eventOrder(a) > eventOrder(b) ? 1 : 0)
    || (BigInt(a.id ?? 0) < BigInt(b.id ?? 0) ? -1 : BigInt(a.id ?? 0) > BigInt(b.id ?? 0) ? 1 : 0))) {
    const at = new Date(e.ts).getTime();
    if (!e.job_id || applied.has(e.job_id) || !Number.isFinite(at) || e.dismissed_at || at <= (dismissedThrough.get(e.job_id) ?? -Infinity)) continue;
    if (e.status === 'answered' && Array.isArray(e.questions) && e.questions.length) {
      const answered = new Set(normaliseQuestions(e.questions).map(blockedQuestionKey));
      const pending = latest.get(e.job_id);
      if (pending) {
        const remaining = pending.questions?.filter(question => !answered.has(blockedQuestionKey(question))) ?? [];
        if (remaining.length) latest.set(e.job_id, { ...pending, questions: remaining });
        else latest.delete(e.job_id);
      }
      continue;
    }
    // Malformed answered metadata cannot stand in for a legacy full resolution.
    if (e.status === 'answered' && e.questions != null && !Array.isArray(e.questions)) continue;
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
      at: new Date(at).toISOString(),
      ...(questions.length ? { questions } : {}),
    });
  }

  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function loadAttention(userId: string, read: typeof query = query): Promise<AttentionItem[]> {
  const events = await read<RunEventRow>(
      `WITH boundaries AS (
         SELECT job_id,
                max(ts) FILTER (WHERE status = ANY($2::text[])
                  AND (status <> 'answered' OR questions IS NULL OR questions = '[]'::jsonb)) AS resolved_at,
                max(GREATEST(ts, dismissed_at)) FILTER (WHERE status = 'needs-human' AND dismissed_at IS NOT NULL) AS dismissed_through
           FROM run_events
          WHERE user_id = $1 AND job_id IS NOT NULL
            AND (status = ANY($2::text[]) OR (status = 'needs-human' AND dismissed_at IS NOT NULL))
          GROUP BY job_id
       )
       SELECT e.id, e.job_id, e.status, e.title, e.company, e.reason, e.url, e.ts, e.questions,
              (extract(epoch FROM e.ts) * 1000000)::bigint::text AS order_at
         FROM run_events e LEFT JOIN boundaries b ON b.job_id = e.job_id
        WHERE e.user_id = $1 AND e.job_id IS NOT NULL AND e.dismissed_at IS NULL
          AND (e.status = ANY($2::text[]) OR e.status = 'needs-human')
          AND (b.resolved_at IS NULL OR e.ts >= b.resolved_at)
          AND (b.dismissed_through IS NULL OR e.ts > b.dismissed_through)
        ORDER BY e.ts, e.id`,
      [userId, RESOLVED_STATUSES],
    );
  const appliedRows = await read<{ job_id: string }>(`SELECT job_id FROM applications WHERE user_id = $1`, [userId]);
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
