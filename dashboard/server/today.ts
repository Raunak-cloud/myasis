import { query } from './db/index.js';
import { RUN_TIME_ZONE } from './entitlements.js';

export interface TodayStats {
  runs: number;
  reviewed: number;
  submitted: number;
}

/** A candidate's current local day, independent of the database server zone. */
const DAY_START = `(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`;

/** Applications Owtomate submitted for this account since local midnight — what the daily limit counts. */
export async function submittedToday(userId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM applications
      WHERE user_id = $1 AND submitted_by_myasis AND applied_at >= ${DAY_START}`,
    [userId, RUN_TIME_ZONE],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Small, durable totals for the Apply dashboard after each completed run. */
export async function loadTodayStats(userId: string): Promise<TodayStats> {
  const [runs, reviewed, submitted] = await Promise.all([
    query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM run_starts
        WHERE user_id = $1 AND started_at >= ${DAY_START}`,
      [userId, RUN_TIME_ZONE],
    ),
    query<{ n: string }>(
      `SELECT count(DISTINCT job_id)::text AS n
         FROM run_events
        WHERE user_id = $1 AND job_id IS NOT NULL AND ts >= ${DAY_START}`,
      [userId, RUN_TIME_ZONE],
    ),
    query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM applications
        WHERE user_id = $1 AND submitted_by_myasis AND applied_at >= ${DAY_START}`,
      [userId, RUN_TIME_ZONE],
    ),
  ]);

  return {
    runs: Number(runs[0]?.n ?? 0),
    reviewed: Number(reviewed[0]?.n ?? 0),
    submitted: Number(submitted[0]?.n ?? 0),
  };
}
