import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { applicationModelIdentity } from './application-model.js';
import type { ApplyOutcome, CandidateProfile, JobListing } from './types.js';
import { FIT_ASSESSMENT_VERSION, FIT_CLASSIFIER_MODEL } from './model-versions.js';
import { loadReviewVerdicts, verdictContext } from './review-verdicts.js';

export type ReviewDisposition = 'external' | 'fit-mismatch' | 'below-score';

export interface ReviewCacheMetadata {
  disposition: ReviewDisposition;
  listingFingerprint?: string;
  contextFingerprint?: string;
  /** Suitability decisions are invalidated by content/context, not a timer. */
  expiresAt: string | null;
  contentFingerprint?: string;
}

export interface ReviewCacheEntry extends ReviewCacheMetadata {
  jobId: string;
  title?: string;
  company?: string;
  reviewedAt: string;
  reason: string;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const normalise = (value: string | undefined) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const DISPOSITIONS = new Set<ReviewDisposition>(['external', 'fit-mismatch', 'below-score']);

/** Stable discovery facts available before opening the detail page. */
export function listingFingerprint(job: JobListing): string {
  return digest({
    id: job.id,
    platform: normalise(job.platform ?? 'seek'),
    title: normalise(job.title),
    company: normalise(job.company),
    location: normalise(job.location),
    salary: normalise(job.salary),
    workArrangement: normalise(job.workArrangement),
    // Search-card fields are available before a detail-page/model call and
    // remain present after detail enrichment, so edits invalidate cheaply.
    teaser: normalise(job.teaser),
  });
}

/** Relative posting ages and source order are not changes to the advert. */
export function reviewContentFingerprint(job: JobListing): string | undefined {
  if (!job.description?.trim()) return undefined;
  return digest({ description: normalise(job.description), title: normalise(job.title), company: normalise(job.company),
    location: normalise(job.location), salary: normalise(job.salary), workArrangement: normalise(job.workArrangement) });
}

function evidenceSignature(): string[] {
  const paths = ['knowledge.json', 'resumes.json', 'answers.json'].map(name => resolve(config.dataDir, name));
  const signatures: string[] = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).at(-1) ?? path;
    try { signatures.push(`${name}:${fileDigest(path)}`); } catch { signatures.push(`${name}:missing`); }
  }
  for (const folder of ['knowledge', 'resumes']) {
    const directory = resolve(config.dataDir, folder);
    try {
      for (const name of readdirSync(directory).sort()) {
        const file = resolve(directory, name);
        try { signatures.push(`${folder}/${name}:${fileDigest(file)}`); } catch { /* ignore subdirectories */ }
      }
    } catch { signatures.push(`${folder}:missing`); }
  }
  return signatures;
}

/** Everything that may legitimately change a suitability decision. */
export function reviewContextFingerprint(profile: CandidateProfile): string {
  const candidateCalls = verdictContext(loadReviewVerdicts());
  return digest({
    version: FIT_ASSESSMENT_VERSION,
    profile,
    evidence: evidenceSignature(),
    ...(candidateCalls ? { candidateCalls } : {}),
    resumeSelection: config.resume.select,
    targetRole: config.targetRole,
    // Search terms decide what is discovered, not whether a discovered job
    // suits the candidate. The sparse-run term renewer changes them after a
    // run; including them here invalidated every sound fit decision and made
    // the next run review the same rejected listings again.
    instructions: config.aiInstructions,
    excludedCompanies: config.excludedCompanies,
    rules: config.rules,
    search: config.search,
    minScore: config.rules.minScore,
    model: FIT_CLASSIFIER_MODEL,
    endpoint: config.celeris.baseUrl,
    applicationModel: applicationModelIdentity(),
  });
}

export function reviewCacheMetadata(
  job: JobListing,
  disposition: ReviewDisposition,
  contextFingerprint: string,
  ttlMs: number | null,
): ReviewCacheMetadata {
  return {
    disposition,
    listingFingerprint: job.discoveryFingerprint ?? listingFingerprint(job),
    ...(disposition !== 'external' ? { contentFingerprint: reviewContentFingerprint(job) } : {}),
    ...(disposition === 'fit-mismatch' || disposition === 'below-score' ? { contextFingerprint } : {}),
    expiresAt: ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString(),
  };
}

export function currentFitReview(job: JobListing, profile: CandidateProfile) {
  const review = job.fitReview;
  return review && review.contentFingerprint === reviewContentFingerprint(job)
    && review.contextFingerprint === reviewContextFingerprint(profile) ? review : undefined;
}

/** A technical failure or uncertain send must never become a suitability veto. */
export function applicationRejectionCache(job: JobListing, outcome: ApplyOutcome, contextFingerprint: string): ReviewCacheMetadata | undefined {
  if (outcome.status !== 'skipped' || outcome.submitPressed || outcome.fitRejection?.source !== 'listing'
    || !job.description?.trim()) return undefined;
  const quote = normalise(outcome.fitRejection.evidence);
  const listing = normalise([job.title, job.company, job.location, job.workArrangement, job.description].filter(Boolean).join('\n'));
  if (!quote || !listing.includes(quote)) return undefined;
  return reviewCacheMetadata(job, 'fit-mismatch', contextFingerprint, REVIEW_TTL.fit);
}

export class ReviewCache {
  private readonly entries = new Map<string, ReviewCacheEntry>();
  private readonly allowExternalApply: boolean;

  constructor(options: { now?: number; cachePath?: string; allowExternalApply?: boolean } = {}) {
    const now = options.now ?? Date.now();
    const cachePath = options.cachePath ?? resolve(config.dataDir, 'review-cache.jsonl');
    this.allowExternalApply = options.allowExternalApply ?? config.allowExternalApply;
    if (!existsSync(cachePath)) return;
    try {
      for (const line of readFileSync(cachePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ReviewCacheEntry;
          const expiresAt = entry.expiresAt === null ? null : Date.parse(entry.expiresAt);
          if (!entry.jobId || !DISPOSITIONS.has(entry.disposition)) continue;
          if (expiresAt === null ? entry.disposition === 'external' : !Number.isFinite(expiresAt) || expiresAt <= now) continue;
          if ((entry.disposition === 'fit-mismatch' || entry.disposition === 'below-score')
            && (!entry.listingFingerprint || !entry.contextFingerprint)) continue;
          const reviewedAt = Date.parse(entry.reviewedAt);
          if (!Number.isFinite(reviewedAt)) continue;
          const key = `${entry.jobId}:${entry.listingFingerprint ?? 'legacy'}`;
          const previous = this.entries.get(key);
          if (!previous || reviewedAt > Date.parse(previous.reviewedAt)) this.entries.set(key, entry);
        } catch { /* One damaged line does not disable the cache. */ }
      }
    } catch { /* A new account has no cache yet. */ }
  }

  prior(job: JobListing, contextFingerprint: string): ReviewCacheEntry | null {
    const fingerprint = job.discoveryFingerprint ?? listingFingerprint(job);
    // Older events lack the richer card fields and full-ad proof. Keep them
    // behind unseen jobs, but require a new content check before suppressing.
    const legacyFingerprint = digest({ id: job.id, platform: normalise(job.platform ?? 'seek'),
      title: normalise(job.title), company: normalise(job.company), teaser: normalise(job.teaser) });
    const entry = this.entries.get(`${job.id}:${fingerprint}`)
      ?? this.entries.get(`${job.id}:${legacyFingerprint}`)
      ?? this.entries.get(`${job.id}:legacy`);
    if (!entry) return null;
    // A plan that supports employer-site applications must not inherit a
    // cheaper plan's off-platform suppression.
    if (entry.disposition === 'external' && this.allowExternalApply) return null;
    // Legacy external rows have no fingerprint, so require the old identity
    // fields as well as their short expiry to avoid cross-board ID collisions.
    if (!entry.listingFingerprint
      && (!entry.title || !entry.company
        || normalise(entry.title) !== normalise(job.title)
        || normalise(entry.company) !== normalise(job.company))) return null;
    if (entry.listingFingerprint && entry.listingFingerprint !== fingerprint && entry.listingFingerprint !== legacyFingerprint) return null;
    if ((entry.disposition === 'fit-mismatch' || entry.disposition === 'below-score')
      && entry.contextFingerprint !== contextFingerprint) return null;
    return entry;
  }

  suppression(job: JobListing, contextFingerprint: string): ReviewCacheEntry | null {
    const entry = this.prior(job, contextFingerprint);
    if (!entry || entry.disposition === 'external') return entry;
    // Search cards cannot prove that the full description is unchanged.
    // Defer these jobs behind unseen listings, then revalidate without AI.
    return entry.contentFingerprint && entry.contentFingerprint === reviewContentFingerprint(job) ? entry : null;
  }
}

export const REVIEW_TTL = {
  external: 7 * 86_400_000,
  fit: null,
} as const;
