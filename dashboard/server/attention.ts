import { query } from './db/index.js';
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

/**
 * A blocked question as the dashboard shows it: the wording, and the choices
 * the form offered when it had any, so the person picks from the same list
 * the form did rather than typing something that will not match on retry.
 */
interface BlockedQuestion {
  question: string;
  /** Complete request shown to the candidate; `question` remains the form's exact label. */
  prompt?: string;
  kind?: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
  options?: string[];
}

/**
 * Accepts both shapes a run has ever written — bare label strings from older
 * runs, and objects from current ones — so old rows still render.
 */
export function normaliseQuestions(raw: unknown): BlockedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockedQuestion[] = [];
  for (const entry of raw) {
    const item: { question?: unknown; prompt?: unknown; kind?: unknown; options?: unknown } =
      typeof entry === 'string' ? { question: entry } : entry && typeof entry === 'object' ? entry : {};
    if (typeof item.question !== 'string') continue;
    // Labels arrive with the form's own line breaks and required-asterisks; one line reads better.
    const question = item.question.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!question) continue;
    /**
     * Never shown, whatever the run wrote. Runs stopped recording password
     * fields once that was noticed, but rows from before then still hold
     * them, and a password typed into this form is stored in plain text and
     * replayed at every later employer. Dropping them here covers the old
     * rows the capture-side fix cannot reach.
     */
    if (/\bpass(word|phrase)\b/i.test(question)) continue;
    const options = Array.isArray(item.options) ? item.options.map(String).filter(Boolean) : [];
    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    out.push({
      question,
      ...(prompt ? { prompt } : {}),
      ...(typeof item.kind === 'string' ? { kind: item.kind as BlockedQuestion['kind'] } : {}),
      ...(options.length ? { options } : {}),
    });
  }
  return out;
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

/**
 * Items are deduped to the latest attempt per job, and anything since
 * applied drops off automatically.
 */
export function resolveAttention(events: RunEventRow[], applied: ReadonlySet<string>): AttentionItem[] {
  const latest = new Map<string, AttentionItem>();

  for (const e of [...events].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)))) {
    if (!e.job_id || applied.has(e.job_id)) continue;
    // Every event participates in the lifecycle. A later resolved outcome
    // clears an older blocker instead of being hidden by the attention query.
    if (!ATTENTION_STATUSES.has(e.status)) {
      latest.delete(e.job_id);
      continue;
    }

    const reason = e.reason ?? 'stopped';
    const questions = normaliseQuestions(e.questions);
    // Only an exact, unanswered required application question creates a user
    // task. Authentication, CAPTCHA, navigation and provider failures remain
    // run outcomes and never enter Needs attention.
    if (!questions.length) {
      latest.delete(e.job_id);
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

export async function loadAttention(userId: string): Promise<AttentionItem[]> {
  const [events, appliedRows] = await Promise.all([
    query<RunEventRow>(
      `SELECT job_id, status, title, company, reason, url, ts, questions
         FROM (
           SELECT DISTINCT ON (job_id)
                  id, job_id, status, title, company, reason, url, ts, questions, dismissed_at
             FROM run_events
            WHERE user_id = $1 AND job_id IS NOT NULL
            ORDER BY job_id, ts DESC, id DESC
         ) AS latest
        WHERE dismissed_at IS NULL
        ORDER BY ts`,
      [userId],
    ),
    query<{ job_id: string }>(`SELECT job_id FROM applications WHERE user_id = $1`, [userId]),
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
