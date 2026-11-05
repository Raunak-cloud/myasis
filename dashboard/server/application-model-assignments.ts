import { getPool, query } from './db/index.js';
import { isAdmin } from './admin-access.js';
import { isApplicationModel, type ApplicationModel } from '../../seek-bot/src/application-model-catalog.js';

export class ApplicationModelAssignmentError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** This value is read from server-owned history, never from run/client settings. */
export async function assignedApplicationModel(userId: string): Promise<ApplicationModel | null> {
  const rows = await query<{ model: string }>(
    'SELECT model FROM application_model_assignments WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  if (!rows.length) return null;
  if (!isApplicationModel(rows[0].model)) throw new Error('This account has an invalid administrator model choice.');
  return rows[0].model;
}

/** Serialize changes for one account and retain who made each actual change. */
export async function assignApplicationModel(actorId: string, userId: string, model: unknown): Promise<void> {
  if (!isApplicationModel(model)) throw new ApplicationModelAssignmentError('Choose Celeris or MiniMax.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`application-model:${userId}`]);
    const actor = (await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL FOR SHARE', [actorId])).rows[0];
    if (!isAdmin(actor?.email)) throw new ApplicationModelAssignmentError('Only administrators can choose a run model.', 403);
    if (!(await client.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rowCount) throw new ApplicationModelAssignmentError('No such account.', 404);
    const previous = (await client.query<{ model: string }>('SELECT model FROM application_model_assignments WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId])).rows[0];
    if (previous?.model !== model) await client.query(
      'INSERT INTO application_model_assignments(user_id,model,assigned_by) VALUES($1,$2,$3)', [userId,model,actorId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
