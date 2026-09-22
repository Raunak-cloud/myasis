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

