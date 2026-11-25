export const RUN_FILTER_LABELS = {
  listingAge: 'Past listing age limit',
  alreadyReviewed: 'Already reviewed',
  alreadyApplied: 'Already applied',
  previouslySkipped: 'Previously skipped',
  excludedEmployer: 'Excluded employers',
  awaitingConfirmation: 'Awaiting confirmation',
  awaitingAnswers: 'Waiting for answers',
  scope: 'Outside application scope',
  savedRetry: 'Saved for retry',
  fit: 'Didn’t match',
  unavailable: 'Listing unavailable',
  other: 'Other filters',
} as const;

export type RunFilterCounts = Partial<Record<keyof typeof RUN_FILTER_LABELS, number>>;

export interface RunSearchProgress {
  found: number;
  matched: number;
  reviewLimit: number | 'unlimited';
  sources: string[];
  filters: RunFilterCounts;
}

function filterGroup(reason: string): keyof typeof RUN_FILTER_LABELS {
  if (/^listing age$|^posted /i.test(reason)) return 'listingAge';
  if (/^already reviewed$|^unchanged rejection$|^recent (fit-mismatch|below-score)$/i.test(reason)) return 'alreadyReviewed';
  if (/^already applied/i.test(reason)) return 'alreadyApplied';
  if (/^previously skipped/i.test(reason)) return 'previouslySkipped';
  if (/^excluded company/i.test(reason)) return 'excludedEmployer';
  if (reason === 'awaiting your confirmation') return 'awaitingConfirmation';
  if (/^waiting for your answer/i.test(reason)) return 'awaitingAnswers';
  if (/^outside run scope$|^external application disabled$|^recent external$/i.test(reason)) return 'scope';
  if (reason === 'saved for application retry') return 'savedRetry';
  if (/^fit mismatch$|^fit needs clarification$|^not a fit$/i.test(reason)) return 'fit';
  if (reason === 'listing unavailable') return 'unavailable';
  return 'other';
}

export function groupRunFilters(reasons: Iterable<readonly [string, number]>): RunFilterCounts {
  const counts: RunFilterCounts = {};
  for (const [reason, count] of reasons) {
    const group = filterGroup(reason);
    counts[group] = (counts[group] ?? 0) + count;
  }
  return counts;
}
