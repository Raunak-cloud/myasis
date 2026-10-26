import { sameApplication, applicationKeys } from './application-identity.js';
import { AppliedIndex } from './store.js';
import type { AppliedRecord, JobListing } from './types.js';

export interface DuplicateReview {
  decision: 'clear' | 'duplicate';
  reason: string;
  keys: string[];
  evidence?: { source: 'board' | 'history'; jobId: string; platform: string; url: string; appliedAt?: string };
}

/** The matching stage owns known-duplicate decisions. Use every confirmed
 * owner record, never a truncated model prompt or fuzzy company/title match.
 * A released/rejected attempt is not a confirmed application. */
export function reviewDuplicate(job: JobListing, history: readonly AppliedRecord[]): DuplicateReview {
  const keys = applicationKeys(job);
  if (job.alreadyApplied) return {
    decision: 'duplicate', keys, reason: job.appliedNote || 'The job board confirms an earlier application to this role.',
    evidence: { source: 'board', jobId: job.id, platform: job.platform ?? 'seek', url: job.url },
  };
  const record = history.find(record => sameApplication(record, job));
  return record ? {
    decision: 'duplicate', keys, reason: 'An application to this exact listing or application destination is already recorded.',
    evidence: { source: 'history', jobId: record.jobId, platform: record.platform, url: record.applicationUrl ?? record.url, appliedAt: record.appliedAt },
  } : { decision: 'clear', keys, reason: 'No confirmed application matches this listing or its known application destination.' };
}

/** Also used for direct/employer and approved Semi auto entry points. Refresh
 * locally at handoff; no model call, browser trip, or second agent decision.
 * A cached clearance supplied on a listing is never trusted. */
export function reviewCurrentDuplicate(job: JobListing): DuplicateReview {
  return reviewDuplicate(job, new AppliedIndex().all);
}

/** One run can apply on two boards. Listings already known to share a form
 * take turns through the same matching decision: the second sees the first
 * result, while an unsuccessful first attempt does not blacklist a vacancy. */
export class DuplicateReviewQueue {
  private readonly active = new Map<string, Promise<void>>();

  async enter(job: JobListing): Promise<() => void> {
    const keys = applicationKeys(job);
    for (;;) {
      const waiting = [...new Set(keys.flatMap(key => this.active.has(key) ? [this.active.get(key)!] : []))];
      if (waiting.length) { await Promise.all(waiting); continue; }
      let resolve!: () => void;
      const done = new Promise<void>(complete => { resolve = complete; });
      for (const key of keys) this.active.set(key, done);
      return () => {
        for (const key of keys) if (this.active.get(key) === done) this.active.delete(key);
        resolve();
      };
    }
  }
}
