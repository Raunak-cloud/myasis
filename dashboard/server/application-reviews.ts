import { getPool, query } from './db/index.js';
import { applicationKeys } from '../../seek-bot/src/application-identity.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';

export interface ReviewSelection { id: string; revision: string }
export class ApplicationReviewError extends Error {}
const recovered = new Set<string>();

export async function recoverApplicationReviews(userId: string): Promise<void> {
  if (recovered.has(userId)) return;
  const { syncRunResultsToDb } = await import('./db/run-sync.js');
  const { userDir } = await import('./userdata.js');
  await syncRunResultsToDb(userId, userDir(userId));
  await finishApplicationReviews(userId);
  recovered.add(userId);
}

export function reviewSelection(value: unknown): ReviewSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ApplicationReviewError('Select between 1 and 10 prepared applications.');
  if (!value.every(item => item && typeof item.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.id)
    && typeof item.revision === 'string' && /^[a-f0-9]{64}$/i.test(item.revision))
    || new Set(value.map(item => item.id)).size !== value.length) throw new ApplicationReviewError('Reload the prepared applications and select them again.');
  return value;
}

export async function listApplicationReviews(userId: string) {
  return query<{ id: string; status: string; detail: string | null; application: PreparedApplication }>(
    `SELECT id::text, status, detail, payload AS application FROM application_reviews
     WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`, [userId]);
}

export async function pendingReviewKeys(userId: string): Promise<string[]> {
  const rows = await query<{ payload: PreparedApplication }>(
    "SELECT payload FROM application_reviews WHERE user_id=$1 AND status IN ('ready','approved')", [userId]);
  return rows.flatMap(row => applicationKeys(row.payload.job));
}

export async function saveApplicationReview(userId: string, draft: PreparedApplication): Promise<void> {
  reviewSelection([{ id: draft.id, revision: draft.revision }]);
  if (!draft.job?.id || !draft.job.url || !Array.isArray(draft.answers)) throw new ApplicationReviewError('Incomplete prepared application.');
  await query(`INSERT INTO application_reviews (user_id,job_key,id,payload,status)
    VALUES ($1,$2,$3,$4,'ready') ON CONFLICT (user_id,job_key) DO UPDATE
    SET id=EXCLUDED.id,payload=EXCLUDED.payload,status='ready',
      detail=CASE WHEN application_reviews.status='approved' THEN 'This application changed after confirmation. Review the updated version before confirming again.' ELSE NULL END,updated_at=now()
    WHERE application_reviews.status <> 'applied'
      AND (application_reviews.payload->>'preparedAt') < (EXCLUDED.payload->>'preparedAt')`,
  [userId, `${draft.job.platform ?? 'seek'}:${draft.job.id}`, draft.id, JSON.stringify(draft)]);
}

/** Lock, validate the version the user saw, and consume each approval once. */
export async function claimApplicationReviews(userId: string, selections: ReviewSelection[]): Promise<PreparedApplication[]> {
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN');
    const result = await connection.query<{ id: string; status: string; payload: PreparedApplication }>(
      'SELECT id::text,status,payload FROM application_reviews WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
      [userId, selections.map(item => item.id)]);
    if (result.rows.length !== selections.length || result.rows.some(row => row.status !== 'ready'
      || row.payload.revision !== selections.find(item => item.id === row.id)?.revision)) {
      throw new ApplicationReviewError('An application changed or is no longer ready. Reload and review it again.');
    }
    await connection.query("UPDATE application_reviews SET status='approved',detail=NULL,updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, selections.map(item => item.id)]);
    await connection.query('COMMIT');
    return selections.map(item => result.rows.find(row => row.id === item.id)!.payload);
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

export async function releaseApplicationReviews(userId: string, ids: string[]): Promise<void> {
  await query("UPDATE application_reviews SET status='ready',updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='approved'", [userId, ids]);
}

export async function dismissApplicationReviews(userId: string, selections: ReviewSelection[]): Promise<void> {
  for (const item of selections) await query(
    "UPDATE application_reviews SET status='dismissed',detail='Skipped by you',updated_at=now() WHERE user_id=$1 AND id=$2 AND payload->>'revision'=$3 AND status='ready'",
    [userId, item.id, item.revision]);
}

export async function recordReviewedOutcome(userId: string, reviewId: string, status: string, detail?: string): Promise<void> {
  await query(`UPDATE application_reviews SET status=$3,detail=$4,updated_at=now()
    WHERE user_id=$1 AND id=$2 AND status='approved'`,
  [userId, reviewId, status === 'applied' || status === 'already-applied' ? 'applied' : 'failed',
    detail ?? (status === 'already-applied' ? 'This application was already submitted.' : status === 'applied' ? 'Application submitted.' : 'The application could not be completed.')]);
}

export async function finishApplicationReviews(userId: string): Promise<void> {
  await query(`UPDATE application_reviews SET status='failed',
    detail='The run ended before submission was confirmed. Check the activity before preparing this job again.',updated_at=now()
    WHERE user_id=$1 AND status='approved'`, [userId]);
}
