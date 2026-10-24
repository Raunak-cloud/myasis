import { query, getPool } from './db/index.js';
import { scheduleFor } from './run-schedule.js';
import { runner, MAX_CONCURRENT } from './runner.js';
import { startRun } from './start-run.js';
import { entitlementsFor, RUN_TIME_ZONE } from './entitlements.js';
import { sessionFor } from './signin.js';
import { sendDailyDigests, digestDue } from './digest.js';
import { sendAccountAlerts } from './alerts.js';
import { sendOperatorAlerts } from './operator-alerts.js';

/** Opt-in schedules are durable, ordered by their oldest due slot, and never catch up in bursts. */

/** How often to look. Fine enough to hit a slot, cheap enough to ignore. */
const TICK_MS = 60_000;

interface AutoScheduleStatus {
  runsUsedToday: number;
  runsPerDay: number;
  /** Null while the account's setup is unfinished: nothing is scheduled until it is. */
  nextRunAt: string | null;
  dueNow: boolean;
  timeZone: string;
  lastError: { message: string; at: string } | null;
  /** The account holder still has setup steps to do before any scheduled run. */
  waitingForSetup: boolean;
  /** The account has not connected a supported job board. */
  waitingForBoard: boolean;
  /** The account holder must complete the first run before scheduling begins. */
  waitingForFirstRun: boolean;
}

export async function autoScheduleFor(userId: string, now: Date = new Date()): Promise<AutoScheduleStatus & { enabled: boolean; applicationMode: 'auto' | 'semi-auto' }> {
  const row = await scheduleFor(userId);
  const user = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  const entitlement = await entitlementsFor(userId, user[0]?.email);
  return {
    enabled: row?.enabled ?? false,
    applicationMode: row?.application_mode ?? 'auto',
    runsUsedToday: entitlement.autoRunsUsedToday,
    runsPerDay: entitlement.autoRunsPerDay,
    nextRunAt: row?.enabled && row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    dueNow: Boolean(row?.enabled && row.next_run_at && new Date(row.next_run_at).getTime() <= now.getTime()),
    timeZone: RUN_TIME_ZONE,
    lastError: row?.last_error ? { message: row.last_error, at: new Date(row.error_at!).toISOString() } : null,
    waitingForSetup: false, waitingForBoard: false, waitingForFirstRun: false,
  };
}

interface ScheduleDependencies {
  activeCount: () => number;
  busy: (userId: string) => boolean;
  start: typeof startRun;
}
const scheduleDependencies: ScheduleDependencies = {
  activeCount: () => runner.activeCount(),
  busy: userId => runner.inUse(userId) || Boolean(sessionFor(userId)),
  start: startRun,
};

export async function autoRunTick(now: Date = new Date(), dependencies = scheduleDependencies): Promise<string[]> {
  if (ticking) return [];
  ticking = true;
  let client: import('pg').PoolClient | undefined;
  let locked = false;
  try {
    client = await getPool().connect();
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(726301, 1) AS locked')).rows[0]!.locked;
    if (!locked) return [];
    const due = await query<{ user_id: string; email: string; application_mode: 'auto' | 'semi-auto'; generation: number }>(
      `SELECT s.user_id::text, u.email, s.application_mode, s.generation
       FROM application_schedules s JOIN users u ON u.id = s.user_id
       WHERE s.enabled AND s.next_run_at <= $1 AND u.blocked_at IS NULL
       ORDER BY s.next_run_at, s.user_id`, [now]);
    const started: string[] = [];
    for (const account of due) {
      if (dependencies.activeCount() >= MAX_CONCURRENT) break;
      if (dependencies.busy(account.user_id)) continue;
      const result = await dependencies.start({ userId: account.user_id, email: account.email, mode: 'live', trigger: 'auto',
        applicationMode: account.application_mode, scheduleGeneration: account.generation })
        .catch(error => ({ ok: false as const, status: 503, error: `Could not start: ${(error as Error).message}` }));
      if (result.ok) started.push(account.user_id);
      else if (result.status !== 409) {
        // Actionable failures remain visible after restarts. No credit/pass means
        // explicit Resume is required after the user resolves the problem.
        await query(`UPDATE application_schedules SET last_error = $3, error_at = $4,
          enabled = CASE WHEN $5 THEN false ELSE enabled END,
          next_run_at = CASE WHEN $5 THEN NULL ELSE now() + interval '15 minutes' END,
          generation = generation + CASE WHEN $5 THEN 1 ELSE 0 END
          WHERE user_id = $1 AND generation = $2 AND enabled`,
        [account.user_id, account.generation, result.error, now, [402, 403].includes(result.status)]);
      }
    }
    return started;
  } finally {
    try { if (locked) await client?.query('SELECT pg_advisory_unlock(726301, 1)'); }
    finally { client?.release(); ticking = false; }
  }
}

let ticking = false;
export function wakeAutoRunner(): void {
  void autoRunTick().catch(error => console.warn('[autorun]', (error as Error).message));
}

let timer: NodeJS.Timeout | null = null;

export function startAutoRunner(): void {
  if (timer) return;
  const tick = () => {
    wakeAutoRunner();
    void sendAccountAlerts().catch(error => console.warn('[alerts]', error.message));
    void sendOperatorAlerts().catch(error => console.warn('[ops-alerts]', error.message));
    if (digestDue(new Date())) void sendDailyDigests().catch(error => console.warn('[digest]', error.message));
  };
  timer = setInterval(tick, TICK_MS);
  // Node keeps a process alive for timers; this one must not be the reason it stays up.
  timer.unref?.();
  console.log(
    `[autorun] explicit opt-in schedules enabled; maximum ${MAX_CONCURRENT} concurrent worker slots`,
  );
  tick();
}
