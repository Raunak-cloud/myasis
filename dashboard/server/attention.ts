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
    const item: { question?: unknown; kind?: unknown; options?: unknown } =
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
    out.push({
      question,
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
/**
 * Plain wording for reasons written before runs produced their own.
 *
 * Older rows hold the technical form — "model budget exhausted (21 calls ·
 * 339614 prompt (28% cached) · $0.05270)" — because that string was once the
 * only one a run produced. Runs now write a plain reason and keep the detail
 * in their log; this covers what is already stored. The final line strips a
 * meter summary from anything the patterns miss, so a token count can never
 * reach the page whatever the wording around it.
 */
const PLAIN: Array<[RegExp, string]> = [
  [/^model budget exhausted/i, 'The application used up its allowance for one attempt.'],
  [/^step budget exhausted/i, 'The application needed more steps than one attempt allows.'],
  [/^stuck for \d+s/i, 'The page stopped responding to what the agent did.'],
  [/^overall time limit/i, 'The application ran out of time.'],
  [/^the agent stopped proposing/i, 'The agent could not work out a next step on this page.'],
  [/^stuck repeating/i, 'The agent kept repeating the same action with no effect.'],
  [/^no progress after six/i, 'The page did not change in response to anything the agent tried.'],
  [/^agent claimed submission/i, 'The application was not confirmed as submitted.'],
  [/^[a-z_]+ failed: /i, 'A step failed while filling in the application.'],
  [/^Fields not verified: (.+)/i, 'Required answers could not be confirmed: $1'],
  [/^the model could not ground \d+ answer\(s\): (.+)/i, 'These questions could not be answered from the profile: $1'],
  [/^submit is on an external site/i, "The application continues on the employer's own site."],
  [/^DRY_RUN/i, 'Rehearsal — nothing was submitted.'],
];

/** A meter summary, wherever it sits: "21 calls · 339614 prompt (28% cached) · 3042 completion · $0.05270". */
const METER = /\s*\(?\d+ calls · .*?\$\d+(?:\.\d+)?\)?/g;

export function plainReason(reason: string): string {
  for (const [pattern, wording] of PLAIN) {
    if (!pattern.test(reason)) continue;
    /**
     * A wording with a "$1" keeps the part of the original it refers to —
     * the list of questions. Any other wording replaces the whole reason:
     * the original's tail is the technical part ("(24 steps)", the meter),
     * which is exactly what must not be shown.
     */
    return wording.includes('$1') ? reason.replace(pattern, wording) : wording;
  }
  return reason.replace(METER, '').trim();
}

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
      reason: plainReason(String(reason)).slice(0, 300),
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
