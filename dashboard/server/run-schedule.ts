import { getPool, one } from './db/index.js';
import type { PoolClient } from 'pg';

export type ApplicationMode = 'auto' | 'semi-auto';
export const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = SCHEDULE_INTERVAL_MS * 4;
const latest = (a: Date | null, b: Date | null): Date | null => a || b ? new Date(Math.max(a ? +new Date(a) : 0, b ? +new Date(b) : 0)) : null;

export interface RunSchedule {
  user_id: string;
  enabled: boolean;
  application_mode: ApplicationMode;
  generation: number;
  next_run_at: Date | null;
  last_started_at: Date | null;
  last_error: string | null;
  error_at: Date | null;
}

/** Absolute elapsed time, independent of midnight, DST, restarts and missed slots. */
export function nextScheduledStart(now: Date, last: Date | null, runsPerDay = 4): Date {
  const interval = DAY_MS / Math.min(4, Math.max(1, runsPerDay));
  return new Date(Math.max(now.getTime(), last ? last.getTime() + interval : 0));
}

export async function scheduleFor(userId: string): Promise<RunSchedule | null> {
  return one<RunSchedule>('SELECT * FROM application_schedules WHERE user_id = $1', [userId]);
}

async function earliestSlot(client: PoolClient, userId: string, now: Date, savedLast: Date | null, runsPerDay: number): Promise<Date> {
  const result = await client.query<{ started_at: Date }>(
    `SELECT started_at FROM run_starts
      WHERE user_id = $1 AND mode = 'live' AND NOT approval_only
        AND trigger IN ('auto', 'manual', 'onboarding')
      ORDER BY started_at DESC LIMIT $2`, [userId, runsPerDay]);
  const next = nextScheduledStart(now, latest(result.rows[0]?.started_at ?? null, savedLast), runsPerDay);
  // Historical manual starts and plan changes cannot bypass the rolling cap.
  const oldest = result.rows.length === runsPerDay ? result.rows.at(-1)!.started_at : null;
  return new Date(Math.max(+next, oldest ? +new Date(oldest) + DAY_MS : 0));
}

/** A repeated Start is idempotent; Pause invalidates even a start already being prepared. */
export async function changeSchedule(userId: string, enabled: boolean, mode: ApplicationMode, runsPerDay = 4): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO application_schedules (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const current = (await client.query<RunSchedule>('SELECT * FROM application_schedules WHERE user_id = $1 FOR UPDATE', [userId])).rows[0]!;
    const next = await earliestSlot(client, userId, new Date(), current.last_started_at, runsPerDay);
    if (!enabled || !current.enabled) {
      await client.query(`UPDATE application_schedules SET enabled = $2, application_mode = $3,
        generation = generation + 1, next_run_at = $4, last_error = NULL, error_at = NULL, updated_at = now()
        WHERE user_id = $1`, [userId, enabled, enabled ? mode : current.application_mode, enabled ? next : null]);
    } else if (current.application_mode !== mode) {
      throw new Error('Pause your current schedule before changing application mode.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/**
 * Serializes the final start with Pause. The row stays locked until the runner
 * has reserved capacity and spawned; a successful Pause can never be followed
 * by a stale scheduled start. Failed capacity reservations spend no slot.
 */
export async function scheduledStart<T extends { ok: boolean }>(
  userId: string, generation: number, mode: ApplicationMode, runsPerDay: number,
  start: () => Promise<T>,
): Promise<T | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query<RunSchedule>('SELECT * FROM application_schedules WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
    const now = new Date();
    const next = await earliestSlot(client, userId, now, row?.last_started_at ?? null, runsPerDay);
    if (!row?.enabled || row.generation !== generation || row.application_mode !== mode
      || !row.next_run_at || new Date(row.next_run_at).getTime() > now.getTime()
      || next.getTime() > now.getTime()) {
      if (row?.enabled && row.generation === generation && row.next_run_at && +next > +new Date(row.next_run_at)) {
        await client.query('UPDATE application_schedules SET next_run_at=$2 WHERE user_id=$1', [userId, next]);
        await client.query('COMMIT');
        return null;
      }
      await client.query('ROLLBACK');
      return null;
    }
    // Reserve durably before spawning. If the process crashes after spawning,
    // the committed run_starts record still prevents an immediate duplicate.
    const result = await start();
    if (result.ok) {
      const startedAt = new Date();
      await client.query(`UPDATE application_schedules SET last_started_at = $2, next_run_at = $3,
        last_error = NULL, error_at = NULL, updated_at = now() WHERE user_id = $1`,
      [userId, startedAt, nextScheduledStart(startedAt, startedAt, runsPerDay)]);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
