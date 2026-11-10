import { getPool, query } from './db/index.js';
import { applicationKeys } from '../../seek-bot/src/application-identity.js';
import type { PreparedApplication } from '../../seek-bot/src/application-review-types.js';
import { consumeApplicationCredit } from './application-credits.js';
import {complimentaryReviewRun} from './bonus-runs.js';
import { isAdmin } from './admin-access.js';
import { isExternalApplicationUrl } from '../../seek-bot/src/job-board-url.js';
import { reviseAttachedCoverLetter } from '../../seek-bot/src/application-documents.js';
import { USER_RUN_LIMITS } from '../../seek-bot/src/run-limits.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userDir } from './userdata.js';
import type { PoolClient } from 'pg';
import { isSiteSecurityFailure, securityRetryAt, securityRetryRemaining, type SecurityRetry } from '../src/securityRetry.js';

export interface ReviewSelection { id: string; revision: string; retry?: boolean }
export interface ApplicationReviewOperatorHold {
  id: string; draftId: string; revision: string; actorUserId: string; reason: string; heldAt: string;
}
const holdMetadata = `CASE WHEN h.id IS NULL THEN NULL ELSE jsonb_build_object('id',h.id::text,'draftId',h.draft_id::text,
  'revision',h.revision,'actorUserId',h.actor_user_id::text,'reason',h.reason,'heldAt',h.held_at) END`;
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
  const rows = await query<{ id: string; status: string; detail: string | null; application: PreparedApplication; operator_hold: ApplicationReviewOperatorHold | null; security_retry_after: Date | null }>(
    `SELECT r.id::text,r.status,r.detail,r.payload AS application,r.security_retry_after,${holdMetadata} AS operator_hold FROM application_reviews r
     LEFT JOIN application_review_operator_holds h ON h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL
     WHERE r.user_id=$1 ORDER BY r.updated_at DESC LIMIT 100`, [userId]);
  const owner = rows.some(row => row.security_retry_after) ? await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]) : [];
  return rows.map(({ security_retry_after, ...row }) => ({ ...row, security_retry: row.status === 'failed' && security_retry_after && !isAdmin(owner[0]?.email)
    ? { reason: 'site-security', retryAt: new Date(security_retry_after).toISOString() } as SecurityRetry : null }));
}

export async function pendingReviewKeys(userId: string): Promise<string[]> {
  const rows = await query<{ payload: PreparedApplication }>(
    `SELECT payload FROM application_reviews WHERE user_id=$1 AND status IN ('ready','approved','failed')
     UNION ALL SELECT jsonb_build_object('job',job) AS payload FROM application_review_operator_holds WHERE user_id=$1 AND released_at IS NULL`, [userId]);
  return [...new Set(rows.flatMap(row => applicationKeys(row.payload.job)))];
}

function operatorText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new ApplicationReviewError(`Provide ${label} of 1 to 2,000 characters.`);
  return value.trim();
}
async function verifyOperator(connection: PoolClient, actorUserId: string, userId: string): Promise<void> {
  if (!/^\d+$/.test(actorUserId) || !/^\d+$/.test(userId)) throw new ApplicationReviewError('Invalid operator or application owner.');
  const actor = await connection.query<{ email: string }>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL FOR SHARE', [actorUserId]);
  if (!isAdmin(actor.rows[0]?.email)) throw new ApplicationReviewError('Only an authenticated administrator may manage an operator hold.');
  const owner = await connection.query('SELECT id FROM users WHERE id=$1 AND blocked_at IS NULL FOR SHARE', [userId]);
  if (!owner.rows.length) throw new ApplicationReviewError('The application owner is unavailable or blocked.');
}
async function exactHeldDraft(connection: PoolClient, userId: string, selection: ReviewSelection, sourceRunId?: string): Promise<PreparedApplication> {
  const current = (await connection.query<ConfirmationRow>('SELECT id::text,status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, selection.id])).rows[0];
  if (current && (!['ready', 'failed'].includes(current.status) || current.payload.revision !== selection.revision)) throw new ApplicationReviewError('The selected draft changed or is already confirmed. No hold was created.');
  let source: PreparedApplication | undefined;
  if (sourceRunId !== undefined) {
    if (!/^\d+$/.test(sourceRunId)) throw new ApplicationReviewError('Invalid source run.');
    const run = (await connection.query<{ started_at: Date; finished_at: Date | null }>('SELECT started_at,finished_at FROM run_starts WHERE user_id=$1 AND id=$2', [userId, sourceRunId])).rows[0];
    if (!run) throw new ApplicationReviewError('The source run does not belong to this application owner.');
    let log: string;
    try { log = readFileSync(resolve(userDir(userId), 'run-log.jsonl'), 'utf8'); }
    catch { throw new ApplicationReviewError('The owner-scoped prepared draft is unavailable. No hold was created.'); }
    for (const line of log.split('\n')) {
      let event: { ts?: string; status?: string; draft?: PreparedApplication };
      try { event = JSON.parse(line); } catch { continue; }
      const at = Date.parse(event.ts ?? '');
      if (event.status === 'prepared' && event.draft?.id === selection.id && event.draft.revision === selection.revision
        && at >= +new Date(run.started_at) && at <= +(run.finished_at ? new Date(run.finished_at) : new Date())) source = event.draft;
    }
    if (!source) throw new ApplicationReviewError('The exact draft and revision were not prepared in this owner’s source run.');
  }
  const draft = current?.payload ?? source;
  if (!draft?.job?.id || !draft.job.url || !Array.isArray(draft.answers)) throw new ApplicationReviewError('The exact owner-scoped prepared draft was not found.');
  const jobKey = `${draft.job.platform ?? 'seek'}:${draft.job.id}`;
  const latest = (await connection.query<{ id: string; status: string; revision: string }>("SELECT id::text,status,payload->>'revision' AS revision FROM application_reviews WHERE user_id=$1 AND job_key=$2 FOR UPDATE", [userId, jobKey])).rows[0];
  if (latest && (latest.id !== selection.id || latest.revision !== selection.revision || !['ready', 'failed'].includes(latest.status))) throw new ApplicationReviewError('A different or confirmed draft is current for this job. No hold was created.');
  return draft;
}

/** An operator hold is separate from candidate choices, model answers, billing
 * and submission status. A durable job-scoped ledger also protects a draft
 * whose normal run import has not happened yet. */
export async function holdApplicationReview(actorUserId: string, userId: string, selection: ReviewSelection, reason: unknown, sourceRunId?: string): Promise<ApplicationReviewOperatorHold> {
  reviewSelection([selection]); const explanation = operatorText(reason, 'an operator hold reason');
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN'); await verifyOperator(connection, actorUserId, userId);
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    // Repeating an already verified hold is a read of its durable ledger, not
    // a new claim about a later draft or a working journal that may rotate.
    const retained = (await connection.query<{ id: string; draft_id: string; revision: string; actor_user_id: string; source_run_id: string | null; reason: string; held_at: Date }>(
      'SELECT id::text,draft_id::text,revision,actor_user_id::text,source_run_id::text,reason,held_at FROM application_review_operator_holds WHERE user_id=$1 AND draft_id=$2 AND revision=$3 AND released_at IS NULL FOR UPDATE',
      [userId, selection.id, selection.revision])).rows[0];
    if (retained) {
      if (retained.actor_user_id !== actorUserId || retained.reason !== explanation || retained.source_run_id !== (sourceRunId ?? null)) throw new ApplicationReviewError('The existing hold has different operator, source or reason evidence. Its original record was preserved.');
      await connection.query('COMMIT');
      return { id: retained.id, draftId: retained.draft_id, revision: retained.revision, actorUserId: retained.actor_user_id, reason: retained.reason, heldAt: new Date(retained.held_at).toISOString() };
    }
    const draft = await exactHeldDraft(connection, userId, selection, sourceRunId), jobKey = `${draft.job.platform ?? 'seek'}:${draft.job.id}`;
    const existing = (await connection.query<{ id: string; draft_id: string; revision: string; actor_user_id: string; reason: string; held_at: Date }>('SELECT id::text,draft_id::text,revision,actor_user_id::text,reason,held_at FROM application_review_operator_holds WHERE user_id=$1 AND job_key=$2 AND released_at IS NULL FOR UPDATE', [userId, jobKey])).rows[0];
    if (existing) {
      if (existing.draft_id !== selection.id || existing.revision !== selection.revision || existing.actor_user_id !== actorUserId || existing.reason !== explanation) throw new ApplicationReviewError('An operator hold already exists for this job. Its original record was preserved.');
      await connection.query('COMMIT');
      return { id: existing.id, draftId: existing.draft_id, revision: existing.revision, actorUserId: existing.actor_user_id, reason: existing.reason, heldAt: new Date(existing.held_at).toISOString() };
    }
    const held = (await connection.query<{ id: string; held_at: Date }>(`INSERT INTO application_review_operator_holds(id,user_id,job_key,draft_id,revision,job,source_run_id,actor_user_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text,held_at`, [randomUUID(), userId, jobKey, draft.id, draft.revision, JSON.stringify(draft.job), sourceRunId ?? null, actorUserId, explanation])).rows[0];
    await connection.query('COMMIT');
    return { id: held.id, draftId: draft.id, revision: draft.revision, actorUserId, reason: explanation, heldAt: new Date(held.held_at).toISOString() };
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

/** Only an explicit administrator resolution can release a hold. Both the
 * original held revision and the currently displayed draft must be identified;
 * a model import, answer save or candidate confirmation never clears it. */
export async function releaseApplicationReviewHold(actorUserId: string, userId: string, holdId: string, original: ReviewSelection, current: ReviewSelection, resolutionEvidence: unknown): Promise<void> {
  reviewSelection([original]); reviewSelection([current]);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(holdId)) throw new ApplicationReviewError('Invalid operator hold.');
  const resolution = operatorText(resolutionEvidence, 'the human resolution evidence');
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN'); await verifyOperator(connection, actorUserId, userId);
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const hold = (await connection.query<{ job_key: string; draft_id: string; revision: string }>('SELECT job_key,draft_id::text,revision FROM application_review_operator_holds WHERE user_id=$1 AND id=$2 AND released_at IS NULL FOR UPDATE', [userId, holdId])).rows[0];
    if (!hold || hold.draft_id !== original.id || hold.revision !== original.revision) throw new ApplicationReviewError('The original held draft changed or the hold is no longer active.');
    const row = (await connection.query<ConfirmationRow & { job_key: string }>('SELECT id::text,job_key,status,payload,credit_consumed FROM application_reviews WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, current.id])).rows[0];
    if (!row || row.job_key !== hold.job_key || row.payload.revision !== current.revision || !['ready', 'failed'].includes(row.status)) throw new ApplicationReviewError('Reload the current unconfirmed draft before releasing its hold.');
    await connection.query('UPDATE application_review_operator_holds SET released_at=clock_timestamp(),released_by_user_id=$3,resolution_evidence=$4 WHERE user_id=$1 AND id=$2 AND released_at IS NULL', [userId, holdId, actorUserId, resolution]);
    await connection.query('COMMIT');
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

export async function saveApplicationReview(userId: string, draft: PreparedApplication,sourceRunId?:string): Promise<void> {
  reviewSelection([{ id: draft.id, revision: draft.revision }]);
  if (!draft.job?.id || !draft.job.url || !Array.isArray(draft.answers)) throw new ApplicationReviewError('Incomplete prepared application.');
  const connection = await getPool().connect().catch((error: Error) => {
    throw new ApplicationReviewError(`Could not save prepared application: ${error.message}`);
  });
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const bonus=await complimentaryReviewRun(connection,userId,sourceRunId,draft.preparedAt);
    // Ignore model-provided attribution. Only a bound parent run can sponsor it.
    draft={...draft,bonusRunId:bonus?.id};
    // A late/replayed worker draft cannot erase a consumed candidate decision,
    // including an approved submission that failed or was stopped. Only an
    // explicit owner edit/retry can alter that retained submission record.
    const saved = await connection.query<{ credit_consumed: boolean }>(`INSERT INTO application_reviews (user_id,job_key,id,payload,status)
    VALUES ($1,$2,$3,$4,'ready') ON CONFLICT (user_id,job_key) DO UPDATE
    SET id=EXCLUDED.id,payload=EXCLUDED.payload,status='ready',
      detail=NULL,updated_at=now()
    WHERE application_reviews.status NOT IN ('approved','applied','failed')
      AND (application_reviews.payload->>'preparedAt') < (EXCLUDED.payload->>'preparedAt')
    RETURNING credit_consumed`,
    [userId, `${draft.job.platform ?? 'seek'}:${draft.job.id}`, draft.id, JSON.stringify(draft)]);
    // Operator holds are independent durable records keyed to this owner/job.
    // Importing a newer model draft cannot erase or release an active hold.
    if (saved.rows[0] && !saved.rows[0].credit_consumed) {
      if(bonus){
        const counted=await connection.query<{count:string}>("SELECT count(*)::text AS count FROM application_reviews WHERE user_id=$1 AND payload->>'bonusRunId'=$2",[userId,bonus.id]);
        if(Number(counted.rows[0]?.count??0)>bonus.max_applications)throw Error('This bonus run has reached its complimentary application limit.');
      }
      const owner = await connection.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]);
      if (!bonus && !isAdmin(owner.rows[0]?.email)) {
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

interface ConfirmationRow { id: string; status: string; payload: PreparedApplication; credit_consumed: boolean; operator_hold?: ApplicationReviewOperatorHold | null; security_retry_after?: Date | null }
function confirmedVersions(rows: ConfirmationRow[], selections: ReviewSelection[], admin = false): PreparedApplication[] {
  const selected = new Map(selections.map(item => [item.id, item]));
  if (rows.length !== selections.length || rows.some(row => {
    const selection = selected.get(row.id);
    return Boolean(row.operator_hold) || row.status !== (selection?.retry === true ? 'failed' : 'ready') || !row.credit_consumed
      || row.payload.revision !== selection?.revision;
  })) {
    throw new ApplicationReviewError('An application changed or is no longer ready. Reload and review it again.');
  }
  const blocked = rows.find(row => row.security_retry_after && securityRetryRemaining({ reason:'site-security',retryAt:new Date(row.security_retry_after).toISOString() }) > 0);
  if (blocked && !admin) throw new ApplicationReviewError(`To help protect your application, retry is available after ${new Intl.DateTimeFormat('en-AU', { dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney' }).format(new Date(blocked.security_retry_after!))} (Sydney time).`);
  return selections.map(item => rows.find(row => row.id === item.id)!.payload);
}

/** Paid preparations can be confirmed even when no unused application credits remain. */
export async function applicationsForConfirmation(userId: string, selections: ReviewSelection[]): Promise<PreparedApplication[]> {
  const rows = await query<ConfirmationRow>(
    `SELECT r.id::text,r.status,r.payload,r.credit_consumed,r.security_retry_after,${holdMetadata} AS operator_hold FROM application_reviews r
     LEFT JOIN application_review_operator_holds h ON h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL
     WHERE r.user_id=$1 AND r.id=ANY($2::uuid[])`,
    [userId, selections.map(item => item.id)]);
  const owner = await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]);
  return confirmedVersions(rows, selections, isAdmin(owner[0]?.email));
}

/** An edit replaces the reviewed version and its matching form answer without spending another credit. */
export async function editApplicationCoverLetter(userId: string, selection: ReviewSelection, value: unknown): Promise<PreparedApplication> {
  reviewSelection([selection]);
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new ApplicationReviewError('Enter a cover letter of 1 to 20,000 characters.');
  const connection = await getPool().connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const result = await connection.query<ConfirmationRow>(
      `SELECT r.id::text,r.status,r.payload,r.credit_consumed,${holdMetadata} AS operator_hold FROM application_reviews r
       LEFT JOIN application_review_operator_holds h ON h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL
       WHERE r.user_id=$1 AND r.id=$2 FOR UPDATE OF r`, [userId, selection.id]);
    const row = result.rows[0];
    if (!row || row.operator_hold || !['ready', 'failed'].includes(row.status) || !row.credit_consumed || row.payload.revision !== selection.revision) {
      throw new ApplicationReviewError('An application changed or is no longer editable. Reload and review it again.');
    }
    const current = row.payload;
    let application: PreparedApplication;
    try { application = await reviseAttachedCoverLetter(current, value, userDir(userId)); }
    catch { throw new ApplicationReviewError('Could not save the cover letter. Please try again.'); }
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
    await connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const result = await connection.query<ConfirmationRow>(
      `SELECT r.id::text,r.status,r.payload,r.credit_consumed,r.security_retry_after,${holdMetadata} AS operator_hold FROM application_reviews r
       LEFT JOIN application_review_operator_holds h ON h.user_id=r.user_id AND h.job_key=r.job_key AND h.released_at IS NULL
       WHERE r.user_id=$1 AND r.id=ANY($2::uuid[]) FOR UPDATE OF r`,
      [userId, selections.map(item => item.id)]);
    const owner = await connection.query<{ email: string }>('SELECT email FROM users WHERE id=$1 FOR SHARE', [userId]);
    const applications = confirmedVersions(result.rows, selections, isAdmin(owner.rows[0]?.email));
    await connection.query("UPDATE application_reviews SET status='approved',detail=NULL,updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, selections.map(item => item.id)]);
    await connection.query('COMMIT');
    return applications;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}

export async function releaseApplicationReviews(userId: string, ids: string[], _selections: ReviewSelection[] = []): Promise<void> {
  await query(`UPDATE application_reviews SET status='failed',
    detail='Submission did not start. Your approval is retained; you can retry this submission.',
    updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='approved'`, [userId, ids]);
}

export async function dismissApplicationReviews(userId: string, selections: ReviewSelection[]): Promise<void> {
  for (const item of selections) await query(
    "UPDATE application_reviews SET status='dismissed',detail='Skipped by you',updated_at=now() WHERE user_id=$1 AND id=$2 AND payload->>'revision'=$3 AND status='ready'",
    [userId, item.id, item.revision]);
}

export async function recordReviewedOutcome(userId: string, reviewId: string, status: string, detail?: string, occurredAt?: string): Promise<void> {
  const failed = status !== 'applied' && status !== 'already-applied';
  const eventTime = occurredAt && Number.isFinite(Date.parse(occurredAt)) ? new Date(Math.min(Date.now(), Date.parse(occurredAt))) : new Date();
  const retryAt = failed && isSiteSecurityFailure(detail ?? '') ? securityRetryAt(eventTime) : null;
  await query(`UPDATE application_reviews SET status=$3,detail=$4,updated_at=now(),
      security_retry_after=CASE WHEN $3='applied' THEN NULL ELSE GREATEST(security_retry_after,$5::timestamptz) END
    WHERE user_id=$1 AND id=$2 AND status='approved'`,
  [userId, reviewId, status === 'applied' || status === 'already-applied' ? 'applied' : 'failed',
    detail ?? (status === 'already-applied' ? 'This application was already submitted.' : status === 'applied' ? 'Application submitted.' : 'The application could not be completed.'),retryAt]);
}

export async function finishApplicationReviews(userId: string): Promise<void> {
  await query(`UPDATE application_reviews SET status='failed',
    detail='Submission was not confirmed. Check your application history on the job site before trying again.',updated_at=now()
    WHERE user_id=$1 AND status='approved'`, [userId]);
}
