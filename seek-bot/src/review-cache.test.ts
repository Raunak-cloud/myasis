import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReviewCache, listingFingerprint, reviewContextFingerprint, type ReviewCacheEntry } from './review-cache.js';
import type { CandidateProfile, JobListing } from './types.js';

const NOW = Date.parse('2026-09-22T00:00:00.000Z');
const job: JobListing = {
  id: '123',
  title: 'Software Engineer',
  company: 'Example Pty Ltd',
  location: 'Sydney NSW',
  url: 'https://www.seek.com.au/job/123',
  platform: 'seek',
};

function withCache(entries: ReviewCacheEntry[], fn: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'review-cache-'));
  const path = join(directory, 'review-cache.jsonl');
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n'));
  try { fn(path); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function entry(overrides: Partial<ReviewCacheEntry> = {}): ReviewCacheEntry {
  return {
    jobId: job.id,
    reviewedAt: '2026-09-21T23:00:00.000Z',
    reason: 'not a fit',
    disposition: 'fit-mismatch',
    listingFingerprint: listingFingerprint(job),
    contextFingerprint: 'candidate-v1',
    expiresAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

test('suppresses an unchanged job before another model review', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v1')?.disposition, 'fit-mismatch');
}));

test('candidate or search context changes invalidate fit decisions', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v2'), null);
}));

test('candidate profile changes produce a different review context', () => {
  const profile = {
    name: 'Alex', nationality: 'Australian', phone: '1', email: 'a@example.com',
    expectedSalary: '80000', noticePeriod: '2 weeks', willingToRelocate: false,
    experienceSummary: 'Frontend developer', skills: ['React'], excludedDomains: [],
    securityClearance: 'None',
  } satisfies CandidateProfile;
  assert.notEqual(
    reviewContextFingerprint(profile),
    reviewContextFingerprint({ ...profile, skills: ['React', 'TypeScript'] }),
  );
});

test('listing identity changes invalidate prior decisions', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression({ ...job, title: 'Senior Software Engineer' }, 'candidate-v1'), null);
}));

test('a changed search-card summary invalidates the cached review', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression({ ...job, teaser: 'New requirements added' }, 'candidate-v1'), null);
}));

test('expired decisions are never reused', () => withCache([
  entry({ expiresAt: '2026-09-21T00:00:00.000Z' }),
], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v1'), null);
}));

test('external decisions ignore candidate changes but not a plan upgrade', () => withCache([
  entry({ disposition: 'external', contextFingerprint: undefined }),
], path => {
  const freeCache = new ReviewCache({ now: NOW, cachePath: path, allowExternalApply: false });
  assert.equal(freeCache.suppression(job, 'candidate-v2')?.disposition, 'external');
  const intensiveCache = new ReviewCache({ now: NOW, cachePath: path, allowExternalApply: true });
  assert.equal(intensiveCache.suppression(job, 'candidate-v2'), null);
}));

test('legacy external history requires matching title and company', () => withCache([
  entry({ disposition: 'external', listingFingerprint: undefined, contextFingerprint: undefined,
    title: job.title, company: job.company }),
], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path, allowExternalApply: false });
  assert.equal(cache.suppression(job, 'candidate-v1')?.disposition, 'external');
  assert.equal(cache.suppression({ ...job, company: 'Different Company' }, 'candidate-v1'), null);
}));
