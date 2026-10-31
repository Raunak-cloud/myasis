import { getPool, query } from './db/index.js';
import { loadAttention } from './attention.js';

/**
 * The candidate's answer bank: questions a run could not answer from the
 * profile, answered once here and reused on every later form that asks the
 * same thing. Exported into each run as `answers.json`.
 */

interface SavedAnswer {
  question: string;
  answer: string;
  createdAt: string;
}

/** A form label is an interaction key; the full question is the reusable fact's context. */
function answerQuestion(item: { question?: unknown; prompt?: unknown }): string {
  const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
  return (prompt || String(item?.question ?? '')).replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function normaliseSavedAnswers(
  answers: ReadonlyArray<{ question?: unknown; prompt?: unknown; answer?: unknown }>,
): Array<{ question: string; answer: string }> {
  return answers.flatMap((item) => {
    const question = answerQuestion(item);
    const answer = String(item?.answer ?? '').trim().slice(0, 4000);
    return question && answer ? [{ question, answer }] : [];
  });
}

export async function listAnswers(userId: string): Promise<SavedAnswer[]> {
  const rows = await query<{ question: string; answer: string; created_at: Date }>(
    `SELECT question, answer, created_at FROM saved_answers WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({ question: row.question, answer: row.answer, createdAt: new Date(row.created_at).toISOString() }));
}

/**
 * Upserts answers and, when they were given for a specific blocked job,
 * keeps any unanswered questions visible. Only a fully answered group clears
 * the job for retry. The facts and lifecycle update commit together.
 */
export async function saveAnswers(
  userId: string,
  answers: Array<{ question: string; prompt?: string; answer: string }>,
  jobId?: string,
): Promise<{ saved: number }> {
  const normalised = normaliseSavedAnswers(answers);
  if (!normalised.length) return { saved: 0 };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Concurrent partial saves must observe the preceding save's remaining
    // questions rather than putting an already answered question back.
    if (jobId) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`candidate-answers:${userId}:${jobId}`]);
    const read: typeof query = async (text, params) => (await client.query(text, params)).rows;
    const pending = jobId ? (await loadAttention(userId, read)).find(item => item.jobId === jobId) : undefined;
    const supplied = new Set(normalised.map(item => item.question));
    const labelOnly = new Set(normaliseSavedAnswers(answers.filter(item => typeof item?.prompt !== 'string' || !item.prompt.trim())).map(item => item.question));
    const remaining = pending?.questions?.filter(question => !supplied.has(answerQuestion(question)) && !labelOnly.has(answerQuestion({ question: question.question }))) ?? [];
    for (const { question, answer } of normalised) {
      await client.query(
        `INSERT INTO saved_answers (user_id, question, answer)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, question) DO UPDATE SET answer = EXCLUDED.answer, created_at = now()`,
        [userId, question, answer],
      );
    }
    if (jobId && pending && remaining.length) {
      // Append the reduced question group; preserve the original audit event.
      await client.query(
        `INSERT INTO run_events(user_id, job_id, status, title, company, reason, url, questions, ts)
         VALUES ($1, $2, 'needs-human', $3, $4, $5, $6, $7::jsonb, clock_timestamp())`,
        [userId, jobId, pending.title, pending.company, pending.reason, pending.url, JSON.stringify(remaining)],
      );
    } else if (jobId) {
      await client.query(
        // A delayed run-log import must not resurrect an older group after
        // all its answers were saved.
        `WITH dismissed AS (UPDATE run_events SET dismissed_at = now()
          WHERE user_id = $1 AND job_id = $2 AND status = 'needs-human' AND dismissed_at IS NULL)
         INSERT INTO run_events(user_id, job_id, status, reason, ts)
         VALUES ($1, $2, 'answered', 'Candidate answers saved for this application.', clock_timestamp())`,
        [userId, jobId],
      );
    }
    await client.query('COMMIT');
    return { saved: normalised.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAnswer(userId: string, question: string): Promise<void> {
  await query(`DELETE FROM saved_answers WHERE user_id = $1 AND question = $2`, [userId, question]);
}
