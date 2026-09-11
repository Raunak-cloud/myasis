import { query } from './db/index.js';

/**
 * Everything a run could not finish on its own — Postgres-backed and scoped
 * to one account. Used to read the single shared `seek-bot/data/run-log.jsonl`
 * regardless of who was signed in; now reads `run_events` (synced per-run by
 * `db/run-sync.ts`) and `applications`, both filtered by `user_id`.
 */

export type AttentionKind = 'captcha' | 'verification' | 'question' | 'off-platform' | 'error';

export interface AttentionItem {
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
export interface BlockedQuestion {
  question: string;
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
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ question: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { question?: unknown; kind?: unknown; options?: unknown };
    if (typeof item.question !== 'string' || !item.question.trim()) continue;
    const options = Array.isArray(item.options) ? item.options.map(String).filter(Boolean) : [];
    out.push({
      question: item.question.trim(),
      ...(typeof item.kind === 'string' ? { kind: item.kind as BlockedQuestion['kind'] } : {}),
      ...(options.length ? { options } : {}),
    });
  }
  return out;
}

const CLASSIFY: Array<[RegExp, AttentionKind]> = [
  [/captcha|not a robot/i, 'captcha'],
  // "verify"/"verification" only: "cannot be answered from the verified profile" is a question, not a wall.
  [/work[- ]rights|seek pass|identity|verif(?:y|ication)\b/i, 'verification'],
  [/not answerable|needs input|question/i, 'question'],
  [/off-platform|external|apply on company/i, 'off-platform'],
];

interface RunEventRow {
  job_id: string | null;
  status: string;
  title: string | null;
  company: string | null;
  reason: string | null;
  url: string | null;
  ts: Date | string;
  questions: unknown[] | null;
}

/**
 * Items are deduped to the latest attempt per job, and anything since
 * applied drops off automatically.
 */
export async function loadAttention(userId: string): Promise<AttentionItem[]> {
  const [events, appliedRows] = await Promise.all([
    query<RunEventRow>(
      `SELECT job_id, status, title, company, reason, url, ts, questions
         FROM run_events
        WHERE user_id = $1
          AND status IN ('needs-human', 'off-platform', 'error')
          AND dismissed_at IS NULL
        ORDER BY ts`,
      [userId],
    ),
    query<{ job_id: string }>(`SELECT job_id FROM applications WHERE user_id = $1`, [userId]),
  ]);
  const applied = new Set(appliedRows.map((r) => r.job_id));

  const latest = new Map<string, AttentionItem>();

  for (const e of events) {
    if (!e.job_id || applied.has(e.job_id)) continue;

    const reason = e.reason ?? 'stopped';
    const questions = normaliseQuestions(e.questions);
    let kind: AttentionKind = e.status === 'off-platform' ? 'off-platform' : e.status === 'error' ? 'error' : 'question';
    for (const [re, k] of CLASSIFY) {
      if (re.test(reason)) {
        kind = k;
        break;
      }
    }
    // A run that recorded the unanswered questions is, whatever the wording, something the candidate can answer.
    if (questions.length && e.status === 'needs-human') kind = 'question';

    // Later entries win: a job may have been retried and resolved differently.
    latest.set(e.job_id, {
      jobId: e.job_id,
      title: e.title ?? `Job ${e.job_id}`,
      company: e.company ?? '—',
      kind,
      reason: String(reason).slice(0, 300),
      url: e.url ?? `https://www.seek.com.au/job/${e.job_id}`,
      at: new Date(e.ts).toISOString(),
      ...(questions.length ? { questions } : {}),
    });
  }

  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
        AND status IN ('needs-human', 'off-platform', 'error')
        AND dismissed_at IS NULL
      RETURNING id`,
    [userId],
  );
  return rows.length;
}
