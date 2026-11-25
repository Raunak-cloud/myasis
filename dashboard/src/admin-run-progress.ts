import type { RunFilterCounts } from '../../seek-bot/src/run-progress.js';

export interface AdminRunProgress {
  found: number | null;
  reviewed: number | null;
  reviewedEstimated: boolean;
  matched: number | null;
  reviewLimit: number | 'unlimited' | null;
  sources: string[];
  filters: RunFilterCounts;
  needsAttention: number | null;
  errors: number | null;
  unconfirmed: number | null;
}
