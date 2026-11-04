import { createHash } from 'node:crypto';
import { getPool } from './db/index.js';
import { candidateAttention, loadAttention } from './attention.js';
import type { PoolClient } from 'pg';

export class AttentionRemovalError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status=status; }
}

async function pending(client: PoolClient, userId: string) {
  const read = async <T extends import('pg').QueryResultRow>(sql: string, values?: unknown[]) => (await client.query<T>(sql, values)).rows;
  const items = await loadAttention(userId, read);
  const events = await read<{job_id: string; latest: string}>(
    'SELECT job_id,max(id)::text AS latest FROM run_events WHERE user_id=$1 GROUP BY job_id', [userId]);
  const latest = new Map(events.map(row => [row.job_id, row.latest]));
  return items.map(item => ({ ...item, removalRevision: createHash('sha256')
    .update(JSON.stringify([userId, latest.get(item.jobId), item])).digest('hex') }));
}

/** A consistent view, with a version bound to the owner and the actual pending facts. */
export async function adminAttention(userId: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const items = await pending(client, userId);
    const result = candidateAttention(items).map((item, index) => ({ ...item, removalRevision: items[index].removalRevision }));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Dismiss only the row the admin reviewed. History, answers and receipts stay intact.
 * The shared owner/job lock serializes with answer saves and worker event imports. */
export async function removeAdminAttention(actorId: string, userId: string, input: unknown) {
  const { jobId, revision } = (input ?? {}) as {jobId?: unknown; revision?: unknown};
  if (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 500
    || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new AttentionRemovalError('Reload the questions and select the row again.', 400);
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`candidate-answers:${userId}:${jobId}`]);
    const current = (await pending(client, userId)).find(item => item.jobId === jobId);
    if (!current || current.removalRevision !== revision) {
      throw new AttentionRemovalError('This row has changed. Refresh the dashboard before removing it.', 409);
    }
    const removed = await client.query<{id: string}>(`UPDATE run_events SET dismissed_at=clock_timestamp()
      WHERE user_id=$1 AND job_id=$2 AND status='needs-human' AND dismissed_at IS NULL RETURNING id::text`, [userId, jobId]);
    await client.query(`INSERT INTO admin_attention_dismissals(actor_user_id,user_id,job_id,revision,event_ids)
      VALUES ($1,$2,$3,$4,$5::bigint[])`, [actorId,userId,jobId,revision,removed.rows.map(row=>row.id)]);
    await client.query('COMMIT');
    return {ok: true, removed: removed.rowCount};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
