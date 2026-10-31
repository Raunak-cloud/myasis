import { getPool, query } from './db/index.js';
import { blockedQuestionKey, isCredentialQuestion } from '../../seek-bot/src/blocked-questions.js';

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
const answerQuestion = blockedQuestionKey;

export class AnswersValidationError extends Error {}

function validAnswer(item: unknown): item is { question: string; prompt?: string; answer: string } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return typeof value.question === 'string' && Boolean(blockedQuestionKey({ question: value.question }))
    && (value.prompt === undefined || typeof value.prompt === 'string')
    && typeof value.answer === 'string' && Boolean(value.answer.trim())
    && value.question.replace(/\s+/g, ' ').trim().length <= 500
    && (typeof value.prompt !== 'string' || value.prompt.replace(/\s+/g, ' ').trim().length <= 500)
    && value.answer.trim().length <= 4000 && !isCredentialQuestion(value);
}

export function normaliseSavedAnswers(answers: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((item) => {
    if (!validAnswer(item)) return [];
    const question = answerQuestion(item);
    const answer = item.answer.trim();
    return question && answer ? [{ question, answer }] : [];
  });
}

export async function listAnswers(userId: string, read: typeof query = query): Promise<SavedAnswer[]> {
  const rows = await read<{ question: string; answer: string; created_at: Date }>(
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
  answers: unknown,
  jobId?: string,
): Promise<{ saved: number }> {
  if (!Array.isArray(answers) || !answers.length || answers.length > 30 || !answers.every(validAnswer)) {
    throw new AnswersValidationError('Provide between 1 and 30 complete answers. Questions may contain up to 500 characters and answers up to 4000.');
  }
  if (jobId !== undefined && (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 256)) {
    throw new AnswersValidationError('Provide a valid application identifier.');
  }
  const normalised = normaliseSavedAnswers(answers);
  const unique = new Map<string, string>();
  for (const item of normalised) {
    if (unique.has(item.question) && unique.get(item.question) !== item.answer) throw new AnswersValidationError('Provide one answer for each question.');
    unique.set(item.question, item.answer);
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Keep saves for the same owner and job ordered, including their facts
    // and lifecycle event. Each event describes only the answers it saved.
    if (jobId) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`candidate-answers:${userId}:${jobId}`]);
    for (const [question, answer] of unique) {
      await client.query(
        `INSERT INTO saved_answers (user_id, question, answer)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, question) DO UPDATE SET answer = EXCLUDED.answer, created_at = now()`,
        [userId, question, answer],
      );
    }
    if (jobId) {
      await client.query(
        // A save can precede a delayed run-log import. Record the precise facts
        // answered, so an unimported, unanswered question is never cleared.
        `INSERT INTO run_events(user_id, job_id, status, reason, questions, ts)
         VALUES ($1, $2, 'answered', 'Candidate answers saved for this application.', $3::jsonb, clock_timestamp())`,
        [userId, jobId, JSON.stringify([...unique.keys()].map(question => ({ question })))],
      );
    }
    await client.query('COMMIT');
    return { saved: unique.size };
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
