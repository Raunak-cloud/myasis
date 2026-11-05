import type { Pool } from 'pg';
import { getPool } from './db/index.js';

export class ApplicationOutcomeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status=status; }
}

/** Candidate-reported interviews/rejections resolve delivery uncertainty.
 * Keep original application content and timestamps, and audit the human
 * confirmation separately from the bot's original receipt evidence. */
export async function recordApplicationOutcome(userId: string, jobId: unknown, platform: unknown, outcome: unknown,
  pool: Pool = getPool()): Promise<boolean> {
  if (!/^\d+$/.test(userId) || typeof jobId !== 'string' || !jobId.trim() || jobId.length > 128
    || platform !== undefined && (typeof platform !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/i.test(platform))
    || outcome !== null && (typeof outcome !== 'string' || !['interview','rejected','closed'].includes(outcome)))
    throw new ApplicationOutcomeError('Choose a valid application and outcome.');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const rows = (await connection.query(`SELECT id,platform,outcome,confirmation_status,title,company,url
      FROM applications WHERE user_id=$1 AND job_id=$2 AND ($3::text IS NULL OR platform=$3)
      AND (submitted_by_myasis OR confirmation_status='unconfirmed') FOR UPDATE`,[userId,jobId,platform ?? null])).rows;
    if (rows.length !== 1) throw new ApplicationOutcomeError(rows.length ? 'Select the application from its job board before recording an outcome.' : 'Application not found.',rows.length ? 409 : 404);
    const row = rows[0], confirmsDelivery = outcome === 'interview' || outcome === 'rejected';
    if (row.confirmation_status && outcome !== null && !confirmsDelivery)
      throw new ApplicationOutcomeError('An interview invitation or rejection can confirm this application reached the employer.');
    if (row.outcome === outcome && !(row.confirmation_status && confirmsDelivery)) {
      await connection.query('COMMIT'); return false;
    }
    await connection.query(`UPDATE applications SET outcome=$3,
      confirmation_status=CASE WHEN $4 THEN NULL ELSE confirmation_status END,
      submitted_by_myasis=CASE WHEN $4 THEN true ELSE submitted_by_myasis END
      WHERE user_id=$1 AND id=$2`,[userId,row.id,outcome,confirmsDelivery]);
    const reason = `Candidate recorded ${outcome ?? 'no outcome'} for the ${row.platform} application.`
      + (row.confirmation_status && confirmsDelivery ? ' Employer delivery is confirmed by the candidate; the original run receipt evidence is unchanged.' : '');
    await connection.query(`INSERT INTO run_events(user_id,job_id,status,title,company,reason,url)
      VALUES($1,$2,'outcome-recorded',$3,$4,$5,$6)`,[userId,jobId,row.title,row.company,reason,row.url]);
    await connection.query('COMMIT'); return true;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}
