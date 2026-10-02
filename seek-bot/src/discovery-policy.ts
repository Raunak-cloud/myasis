/** Lightweight-ranking score that counts as useful discovery yield. */
export const DISCOVERY_PRIORITY_FLOOR = 50;

/**
 * Discovery only needs enough strong stubs to fill the detail-review buffer;
 * collecting more cannot improve a run once neither the evaluation nor
 * candidate budget can consume them.
 */
export function discoveryTarget(maxEvaluations: number, candidateCap: number): number {
  return Math.max(0, Math.min(maxEvaluations, candidateCap));
}

export function nextLowYieldStreak(previous: number, promisingJobsOnPage: number): number {
  return promisingJobsOnPage > 0 ? 0 : previous + 1;
}

export function shouldStopDiscovery(input: {
  pageNumber: number;
  maxPages: number;
  promisingJobs: number;
  target: number;
}): boolean {
  return input.pageNumber < input.maxPages
    && input.target > 0
    && input.promisingJobs >= input.target;
}


/**
 * The narrowest listing-age window a board's search offers that still covers
 * the candidate's maximum age, or none when no offered window is wide enough.
 *
 * Boards only accept their own fixed windows. Rounding up keeps every listing
 * the candidate wants; the local age check still drops the few days extra.
 */
export function boardAgeWindow(maxAgeDays: number, offered: readonly number[]): number | undefined {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return undefined;
  return [...offered].sort((a, b) => a - b).find((days) => days >= maxAgeDays);
}
