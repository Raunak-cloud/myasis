import { listingAgeDays } from './listing-age.js';
import type { JobListing } from './types.js';

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

export function shouldStopDiscovery(input: {
  promisingJobs: number;
  target: number;
}): boolean {
  return input.target > 0
    && input.promisingJobs >= input.target;
}

/** Transport batches continue without a page budget. Only date-ordered boards
 * may end at an age boundary; unordered feeds must reach actual exhaustion. */
export function discoveryBatchEnd(jobs: JobListing[], seen: Set<string>, maxAgeDays: number, newestFirst: boolean): 'end' | 'age' | 'repeat' | undefined {
  if (!jobs.length) return 'end';
  const fresh = jobs.some(job => !seen.has(job.id));
  for (const job of jobs) seen.add(job.id);
  if (!fresh) return 'repeat';
  if (newestFirst && jobs.every(job => {
    const age = listingAgeDays(job);
    return age !== undefined && age > maxAgeDays;
  })) return 'age';
  return undefined;
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
