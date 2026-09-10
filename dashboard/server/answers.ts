import { query } from './db/index.js';

/**
 * The candidate's answer bank: questions a run could not answer from the
 * profile, answered once here and reused on every later form that asks the
 * same thing. Exported into each run as `answers.json`.
 */

export interface SavedAnswer {
  question: string;
  answer: string;
  createdAt: string;
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
 * clears that job off the attention list so the next run retries it with the
 * answers in hand.
 */
export async function saveAnswers(
  userId: string,
  answers: Array<{ question: string; answer: string }>,
  jobId?: string,
): Promise<{ saved: number }> {
  let saved = 0;
  for (const item of answers) {
    const question = String(item.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const answer = String(item.answer ?? '').trim().slice(0, 4000);
    if (!question || !answer) continue;
    await query(
      `INSERT INTO saved_answers (user_id, question, answer)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, question) DO UPDATE SET answer = EXCLUDED.answer, created_at = now()`,
      [userId, question, answer],
    );
    saved++;
  }
  if (saved && jobId) {
    await query(
      `UPDATE run_events SET dismissed_at = now()
        WHERE user_id = $1 AND job_id = $2 AND status = 'needs-human' AND dismissed_at IS NULL`,
      [userId, jobId],
    );
  }
  return { saved };
}

export async function deleteAnswer(userId: string, question: string): Promise<void> {
  await query(`DELETE FROM saved_answers WHERE user_id = $1 AND question = $2`, [userId, question]);
}
