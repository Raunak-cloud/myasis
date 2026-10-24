/** Calendar boundary shared by quota readers without loading plan or billing services. */
export const RUN_TIME_ZONE = process.env.RUN_TIME_ZONE?.trim() || 'Australia/Sydney';

/**
 * Completion health and scheduled allowance are different facts. A run can
 * time out or be stopped after sending real applications; that work still
 * uses one daily slot. Empty unsuccessful attempts remain retryable.
 * Only internal, fixed aliases are accepted; no request text becomes SQL.
 */
export function countedRunSql(alias: 'r' | 's'): string {
  return `(${alias}.finished_at IS NOT NULL AND (${alias}.successful OR (${alias}.mode = 'live' AND ${alias}.applied > 0)))`;
}
