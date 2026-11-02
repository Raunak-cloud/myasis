import { getPool, query } from './db/index.js';
import { blockedQuestionKey, isCredentialQuestion } from '../../seek-bot/src/blocked-questions.js';
import { loadAttention } from './attention.js';
import { verifiedQuestionSnapshot } from '../../seek-bot/src/question-snapshot-node.js';
import { canonicalQuestionResponse, questionAnswerText, questionResponseIssue, type QuestionResponse, type QuestionSnapshot } from '../../seek-bot/src/question-snapshot.js';
import { questionPatternIssue } from '../../seek-bot/src/question-patterns.js';

/**
 * The candidate's answer bank: questions a run could not answer from the
 * profile, answered once here and reused on every later form that asks the
 * same thing. Exported into each run as `answers.json`.
 */

interface SavedAnswer {
  question: string;
  answer: string;
  createdAt: string;
  snapshot?: QuestionSnapshot;
  response?: QuestionResponse;
  storageKey?: string;
}

/** A form label is an interaction key; the full question is the reusable fact's context. */
const answerQuestion = blockedQuestionKey;

export class AnswersValidationError extends Error {}

function validAnswer(item: unknown): item is { question: string; prompt?: string; answer: string } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  if (['snapshot','questionId','revision','response'].some(k=>value[k]!==undefined)
    || [value.question,value.prompt].some(v=>typeof v==='string'&&/^q2_[a-f0-9]{64}(?::|$)/.test(v.trim()))) return false;
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
  const rows = await read<{ question: string; answer: string; created_at: Date; question_schema?: unknown; answer_value?: unknown }>(
    `SELECT question, answer, created_at, question_schema, answer_value FROM saved_answers WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.flatMap(row => {
    const base={answer:row.answer,createdAt:new Date(row.created_at).toISOString()};
    if (row.question_schema != null) {
      if(!verifiedQuestionSnapshot(row.question_schema)||questionResponseIssue(row.question_schema,row.answer_value))return [];
      return [{...base,question:row.question_schema.prompt,snapshot:row.question_schema,response:row.answer_value as QuestionResponse,storageKey:row.question}];
    }
    return [{...base,question:row.question}];
  });
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
  const versioned=(v:unknown):v is {questionId:string;revision:string;response:QuestionResponse}=>!!v&&typeof v==='object'&&!Array.isArray(v)&&'questionId' in v&&typeof v.questionId==='string'&&/^q2_[a-f0-9]{64}$/.test(v.questionId)&&'revision' in v&&typeof v.revision==='string'&&/^[a-f0-9]{64}$/.test(v.revision)&&'response' in v&&!!v.response&&typeof v.response==='object'&&!Array.isArray(v.response);
  if (!Array.isArray(answers) || !answers.length || answers.length > 30 || !answers.every(v=>validAnswer(v)||versioned(v))) {
    throw new AnswersValidationError('Provide between 1 and 30 complete answers. Questions may contain up to 500 characters and answers up to 4000.');
  }
  if (answers.some(versioned) && !jobId) throw new AnswersValidationError('Versioned answers require their application identifier.');
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
    const pending=jobId?await loadAttention(userId, async <T extends import('pg').QueryResultRow>(sql:string,params?:unknown[]) => (await client.query<T>(sql,params)).rows):[];
    const current=pending.find(item=>item.jobId===jobId)?.questions??[];
    const snapshots:QuestionSnapshot[]=[];
    const responses=new Map<string,QuestionResponse>();
    const replayed=new Set<string>();
    for (const item of answers) {
      if(!versioned(item)) {
        if(current.some(q=>q.snapshot && (q.question===item.question||q.prompt===item.prompt))) throw new AnswersValidationError('Reload this application and answer its original controls.');
        continue;
      }
      const snapshot=current.find(q=>q.snapshot?.id===item.questionId)?.snapshot;
      if(!snapshot) {
        // A successful response may have been lost on the network. Only an
        // exact already-committed fact AND this job's immutable answer event
        // can acknowledge a replay. It cannot change a fact or clear a task.
        const key=`${item.questionId}:${item.revision}`;
        const row=(await client.query<{question_schema:unknown;answer_value:unknown}>(
          `SELECT s.question_schema,s.answer_value FROM saved_answers s
            WHERE s.user_id=$1 AND s.question=$2 AND EXISTS (
              SELECT 1 FROM run_events e CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(e.questions)='array' THEN e.questions ELSE '[]'::jsonb END) q
               WHERE e.user_id=$1 AND e.job_id=$3 AND e.status='answered'
                 AND q->'snapshot'->>'id'=$4 AND q->'snapshot'->>'revision'=$5)`,
          [userId,key,jobId,item.questionId,item.revision])).rows[0];
        if(row&&verifiedQuestionSnapshot(row.question_schema)&&!questionResponseIssue(row.question_schema,item.response)
          &&!questionResponseIssue(row.question_schema,row.answer_value)
          &&JSON.stringify(canonicalQuestionResponse(row.question_schema,item.response))===JSON.stringify(canonicalQuestionResponse(row.question_schema,row.answer_value as QuestionResponse))) {
          replayed.add(key);continue;
        }
      }
      if(!snapshot||snapshot.revision!==item.revision) throw new AnswersValidationError('This question changed or is no longer pending. Reload the application before saving.');
      const issue=questionResponseIssue(snapshot,item.response);
      if(issue)throw new AnswersValidationError(issue);
      const key=blockedQuestionKey({snapshot});
      const response=canonicalQuestionResponse(snapshot,item.response);
      const answer=questionAnswerText(snapshot,response);
      if(responses.has(key)&&JSON.stringify(responses.get(key))!==JSON.stringify(response))throw new AnswersValidationError('Provide one answer for each question.');
      responses.set(key,response);
      unique.set(key,answer);snapshots.push(snapshot);
    }
    const patternIssue=await questionPatternIssue(snapshots.map(snapshot=>({snapshot,response:responses.get(blockedQuestionKey({snapshot}))!})));
    if(patternIssue)throw new AnswersValidationError(patternIssue);
    // Different jobs may save overlapping legacy facts. A stable row-lock
    // order prevents opposite answer orders from deadlocking their upserts.
    for (const [question, answer] of [...unique].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      const snapshot=snapshots.find(s=>blockedQuestionKey({snapshot:s})===question);
      const response=responses.get(question);
      await client.query(
        `INSERT INTO saved_answers (user_id, question, answer, question_schema, answer_value)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (user_id, question) DO UPDATE SET answer = EXCLUDED.answer, question_schema=EXCLUDED.question_schema, answer_value=EXCLUDED.answer_value, created_at = now()`,
        [userId, question, answer, snapshot?JSON.stringify(snapshot):null, response?JSON.stringify(response):null],
      );
    }
    if (jobId&&unique.size) {
      await client.query(
        // A save can precede a delayed run-log import. Record the precise facts
        // answered, so an unimported, unanswered question is never cleared.
        `INSERT INTO run_events(user_id, job_id, status, reason, questions, ts)
         VALUES ($1, $2, 'answered', 'Candidate answers saved for this application.', $3::jsonb, clock_timestamp())`,
        [userId, jobId, JSON.stringify([...unique.keys()].map(question => {const snapshot=snapshots.find(s=>blockedQuestionKey({snapshot:s})===question);return snapshot?{question:snapshot.prompt,snapshot}:{question};}))],
      );
    }
    await client.query('COMMIT');
    return { saved: new Set([...unique.keys(),...replayed]).size };
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
