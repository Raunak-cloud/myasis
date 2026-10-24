import { getPool, query } from './db/index.js';
import { applicationKeys } from '../../seek-bot/src/application-identity.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import { consumeApplicationCredit } from './application-credits.js';
import { isAdmin } from './admin-access.js';
import { isExternalApplicationUrl } from '../../seek-bot/src/job-board-url.js';
import { withCoverLetter } from '../../seek-bot/src/application-review-content.js';
import { USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';

export interface ReviewSelection { id: string; revision: string; retry?: boolean }
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
  if (!Array.isArray(value) || value.length < 1 || value.length > USER_RUN_LIMITS.MAX_APPS_PER_DAY) throw new ApplicationReviewError(`Select between 1 and ${USER_RUN_LIMITS.MAX_APPS_PER_DAY} prepared applications.`);
  if (!value.every(item => item && typeof item.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.id)
    && typeof item.revision === 'string' && /^[a-f0-9]{64}$/i.test(item.revision)
    && (item.retry === undefined || typeof item.retry === 'boolean'))
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
  const connection = await getPool().connect().catch((error: Error) => {
    throw new ApplicationReviewError(`Could not save prepared application: ${error.message}`);
  });
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const saved = await connection.query<{ credit_consumed: boolean }>(`INSERT INTO application_reviews (user_id,job_key,id,payload,status)
    VALUES ($1,$2,$3,$4,'ready') ON CONFLICT (user_id,job_key) DO UPDATE
    SET id=EXCLUDED.id,payload=EXCLUDED.payload,status='ready',
      detail=CASE WHEN application_reviews.status='approved' THEN 'This application changed after confirmation. Review the updated version before confirming again.' ELSE NULL END,updated_at=now()
    WHERE application_reviews.status <> 'applied'
      AND (application_reviews.payload->>'preparedAt') < (EXCLUDED.payload->>'preparedAt')
    RETURNING credit_consumed`,
    [userId, `${draft.job.platform ?? 'seek'}:${draft.job.id}`, draft.id, JSON.stringify(draft)]);
    if (saved.rows[0] && !saved.rows[0].credit_consumed) {
      const owner = await connection.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]);
      if (!isAdmin(owner.rows[0]?.email)) {
        await consumeApplicationCredit(connection, userId, draft.job.applicationMode === 'external' || isExternalApplicationUrl(draft.formUrl));
      }
      await connection.query('UPDATE application_reviews SET credit_consumed=true WHERE user_id=$1 AND job_key=$2',
        [userId, `${draft.job.platform ?? 'seek'}:${draft.job.id}`]);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw new ApplicationReviewError(`Could not save prepared application: ${(error as Error).message}`);
  } finally { connection.release(); }
}

interface ConfirmationRow { id: string; status: string; payload: PreparedApplication; credit_consumed: boolean }
function confirmedVersions(rows: ConfirmationRow[], selections: ReviewSelection[]): PreparedApplication[] {
  const selected = new Map(selections.map(item => [item.id, item]));
  if (rows.length !== selections.length || rows.some(row => {
    const selection = selected.get(row.id);
    return row.status !== (selection?.retry === true ? 'failed' : 'ready') || !row.credit_consumed
      || row.payload.revision !== selection?.revision;
  })) {
    throw new ApplicationReviewError('An application changed or is no longer ready. Reload and review it again.');
  }
  return selections.map(item => rows.find(row => row.id === item.id)!.payload);
}

/** Paid preparations can be confirmed even when no unused application credits remain. */
export async function applicationsForConfirmation(userId: string, selections: ReviewSelection[]): Promise<PreparedApplication[]> {
  const rows = await query<ConfirmationRow>(
    'SELECT id::text,status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=ANY($2::uuid[])',
    [userId, selections.map(item => item.id)]);
  return confirmedVersions(rows, selections);
}

/** An edit replaces the reviewed version and its matching form answer without spending another credit. */
export async function editApplicationCoverLetter(userId: string, selection: ReviewSelection, value: unknown): Promise<PreparedApplication> {
  reviewSelection([selection]);
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new ApplicationReviewError('Enter a cover letter of 1 to 20,000 characters.');
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN');
    const result = await connection.query<ConfirmationRow>(
      'SELECT id::text,status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, selection.id]);
    const row = result.rows[0];
    if (!row || !['ready', 'failed'].includes(row.status) || !row.credit_consumed || row.payload.revision !== selection.revision) {
      throw new ApplicationReviewError('An application changed or is no longer editable. Reload and review it again.');
    }
    const current = row.payload;
    const application = withCoverLetter(current, value);
    await connection.query("UPDATE application_reviews SET payload=$3,detail=CASE WHEN status='ready' THEN NULL ELSE detail END,updated_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('ready','failed')",
      [userId, selection.id, JSON.stringify(application)]);
    await connection.query('COMMIT');
    return application;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

/** Lock, validate the version the user saw, and consume each approval once. */
export async function claimApplicationReviews(userId: string, selections: ReviewSelection[]): Promise<PreparedApplication[]> {
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN');
    const result = await connection.query<ConfirmationRow>(
      'SELECT id::text,status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
      [userId, selections.map(item => item.id)]);
    const applications = confirmedVersions(result.rows, selections);
    await connection.query("UPDATE application_reviews SET status='approved',detail=NULL,updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, selections.map(item => item.id)]);
    await connection.query('COMMIT');
    return applications;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

export async function releaseApplicationReviews(userId: string, ids: string[], selections: ReviewSelection[] = []): Promise<void> {
  const retries = selections.filter(item => item.retry === true).map(item => item.id);
  await query(`UPDATE application_reviews SET
    status=CASE WHEN id=ANY($3::uuid[]) THEN 'failed' ELSE 'ready' END,
    detail=CASE WHEN id=ANY($3::uuid[]) THEN 'The retry did not start. You can retry this application again.' ELSE detail END,
    updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='approved'`, [userId, ids, retries]);
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
    detail='Submission was not confirmed. You can retry this application.',updated_at=now()
    WHERE user_id=$1 AND status='approved'`, [userId]);
}
