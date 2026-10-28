import { assessFit, type FitAssessment } from './llm.js';
import { currentFitReview, reviewContentFingerprint, reviewContextFingerprint } from './review-cache.js';
import { deterministicExclusion } from './scoring.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';

/** Refresh provider facts without losing trusted matcher state. Changed facts
 * return to the matcher before any candidate data reaches an application form. */
export async function refreshMatchedApplication(
  previous: JobListing, fresh: JobListing, profile: CandidateProfile,
  match: (job: JobListing, profile: CandidateProfile) => Promise<FitAssessment> = assessFit,
): Promise<{ job: JobListing } | { outcome: ApplyOutcome }> {
  if (previous.id !== fresh.id || previous.platform !== fresh.platform) throw new Error('The refreshed listing is for a different job.');
  const job: JobListing = { ...fresh, source: previous.source, discoveryFingerprint: previous.discoveryFingerprint, fitReview: previous.fitReview };
  const excluded = deterministicExclusion(job);
  if (excluded) return { outcome: { status: 'skipped', jobId: job.id, reason: excluded } };
  if (currentFitReview(job, profile)) return { job };
  delete job.fitReview;
  // An explicit selection remains the candidate's suitability decision.
  if (job.source === 'chosen') return { job };
  const fit = await match(job, profile);
  if (!fit.shouldApply) return { outcome: {
    status: 'skipped', jobId: job.id,
    reason: `Updated matching review: ${fit.reason}`,
  } };
  const contentFingerprint = reviewContentFingerprint(job);
  if (!contentFingerprint) throw new Error('The refreshed listing has no description for its matching review.');
  job.fitReview = { score: fit.matchScore, reason: fit.reason, evidence: fit.evidence,
    ...(fit.roleFitCheck ? { roleFitCheck: fit.roleFitCheck } : {}),
    ...(fit.workArrangementCheck ? { workArrangementCheck: fit.workArrangementCheck } : {}),
    contentFingerprint, contextFingerprint: reviewContextFingerprint(profile) };
  return { job };
}
