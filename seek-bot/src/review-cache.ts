import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { CandidateProfile, JobListing } from './types.js';
import { FIT_ASSESSMENT_VERSION, FIT_CLASSIFIER_MODEL } from './model-versions.js';

export type ReviewDisposition = 'external' | 'fit-mismatch' | 'below-score' | 'policy';

export interface ReviewCacheMetadata {
  disposition: ReviewDisposition;
  listingFingerprint?: string;
  contextFingerprint?: string;
  expiresAt: string;
}

export interface ReviewCacheEntry extends ReviewCacheMetadata {
  jobId: string;
  title?: string;
  company?: string;
  reviewedAt: string;
  reason: string;
}

const CACHE = resolve(config.dataDir, 'review-cache.jsonl');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const normalise = (value: string | undefined) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const DISPOSITIONS = new Set<ReviewDisposition>(['external', 'fit-mismatch', 'below-score', 'policy']);

/** Stable discovery facts available before opening the detail page. */
export function listingFingerprint(job: JobListing): string {
  return digest({
    id: job.id,
    platform: normalise(job.platform ?? 'seek'),
    title: normalise(job.title),
    company: normalise(job.company),
    // Search-card fields are available before a detail-page/model call and
    // remain present after detail enrichment, so edits invalidate cheaply.
    teaser: normalise(job.teaser),
  });
}

function evidenceSignature(): string[] {
  const paths = ['knowledge.json', 'resumes.json'].map(name => resolve(config.dataDir, name));
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
  return digest({
    version: FIT_ASSESSMENT_VERSION,
    profile,
    evidence: evidenceSignature(),
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
  });
}

export function reviewCacheMetadata(
  job: JobListing,
  disposition: ReviewDisposition,
  contextFingerprint: string,
  ttlMs: number,
): ReviewCacheMetadata {
  return {
    disposition,
    listingFingerprint: listingFingerprint(job),
    ...(disposition === 'fit-mismatch' || disposition === 'below-score' ? { contextFingerprint } : {}),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

export class ReviewCache {
  private readonly entries = new Map<string, ReviewCacheEntry>();
  private readonly allowExternalApply: boolean;

  constructor(options: { now?: number; cachePath?: string; allowExternalApply?: boolean } = {}) {
    const now = options.now ?? Date.now();
    const cachePath = options.cachePath ?? CACHE;
    this.allowExternalApply = options.allowExternalApply ?? config.allowExternalApply;
    if (!existsSync(cachePath)) return;
    try {
      for (const line of readFileSync(cachePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ReviewCacheEntry;
          const expiresAt = Date.parse(entry.expiresAt);
          if (!entry.jobId || !DISPOSITIONS.has(entry.disposition) || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
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

  suppression(job: JobListing, contextFingerprint: string): ReviewCacheEntry | null {
    const fingerprint = listingFingerprint(job);
    const entry = this.entries.get(`${job.id}:${fingerprint}`)
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
    if (entry.listingFingerprint && entry.listingFingerprint !== fingerprint) return null;
    if ((entry.disposition === 'fit-mismatch' || entry.disposition === 'below-score')
      && entry.contextFingerprint !== contextFingerprint) return null;
    return entry;
  }
}

export const REVIEW_TTL = {
  external: 7 * 86_400_000,
  fit: 7 * 86_400_000,
  policy: 7 * 86_400_000,
} as const;
