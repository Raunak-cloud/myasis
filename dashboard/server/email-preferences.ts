import { one } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { accountUnavailable } from './account-lifecycle.js';

export const DAILY_SUMMARY_KEY = 'DAILY_SUMMARY_EMAILS';

/** Existing accounts stay opted in; deleted or deleting accounts cannot send. */
export async function dailySummaryEnabled(userId: string): Promise<boolean> {
  if (accountUnavailable(userId)) return false;
  const row = await one<{ value: string }>(
    `SELECT COALESCE(s.value, 'on') AS value FROM users u
       LEFT JOIN settings s ON s.user_id = u.id AND s.key = $2
      WHERE u.id = $1 AND u.blocked_at IS NULL`, [userId, DAILY_SUMMARY_KEY]);
  return row !== null && row.value !== 'off';
}

export async function setDailySummaryEnabled(userId: string, enabled: boolean): Promise<void> {
  await upsertSettingRow(userId, DAILY_SUMMARY_KEY, enabled ? 'on' : 'off');
}
