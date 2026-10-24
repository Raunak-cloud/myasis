/** User-selectable limits shared by the dashboard and application runner. */
export const USER_RUN_LIMITS = {
  MAX_AGE_DAYS: 30,
  MAX_APPS_PER_DAY: 100,
  PAGES_PER_KEYWORD: 6,
} as const;

type LimitKey = keyof typeof USER_RUN_LIMITS;
const LABELS: Record<LimitKey, string> = {
  MAX_AGE_DAYS: 'Max listing age',
  MAX_APPS_PER_DAY: 'Daily application cap',
  PAGES_PER_KEYWORD: 'Search pages per term',
};

export function userRunLimitError(updates: Record<string, unknown>): { key: LimitKey; message: string } | null {
  for (const key of Object.keys(USER_RUN_LIMITS) as LimitKey[]) {
    if (updates[key] === undefined) continue;
    const raw = String(updates[key] ?? '').trim();
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 1 || value > USER_RUN_LIMITS[key]) {
      return { key, message: `${LABELS[key]} must be between 1 and ${USER_RUN_LIMITS[key]}.` };
    }
  }
  return null;
}

/** Bound legacy values and direct runner inputs, including admin inputs. */
export function boundedUserRunLimit(key: LimitKey, raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return !raw?.trim() || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(USER_RUN_LIMITS[key], Math.floor(value)));
}

export function dailyApplicationLimit(raw: string | undefined): number {
  return !raw?.trim() || !Number.isFinite(Number(raw)) || Number(raw) <= 0
    ? USER_RUN_LIMITS.MAX_APPS_PER_DAY : boundedUserRunLimit('MAX_APPS_PER_DAY', raw, USER_RUN_LIMITS.MAX_APPS_PER_DAY);
}
