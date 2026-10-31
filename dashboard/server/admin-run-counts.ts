/** Historical preparation events belong to the account and the run's time window.
 * The event remains in history even after the candidate confirms or dismisses a draft. */
export const preparedEventsCountSql = `(SELECT count(*) FROM run_events e
  WHERE e.user_id = r.user_id AND e.status = 'prepared'
    AND e.ts >= r.started_at AND e.ts <= COALESCE(r.finished_at, CURRENT_TIMESTAMP))`;

/** Live preparations have not necessarily been synced to run_events yet. */
export function preparedRunCount(recorded: string | number, runId: string, currentRunId: string | null, livePrepared: number): number {
  return runId === currentRunId ? livePrepared : Number(recorded);
}
