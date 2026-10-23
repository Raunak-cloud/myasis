import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReviewCache, listingFingerprint, reviewContentFingerprint, reviewCacheMetadata, reviewContextFingerprint, REVIEW_TTL, type ReviewCacheEntry } from './review-cache.js';
import { config } from './config.js';
import type { CandidateProfile, JobListing } from './types.js';

const NOW = Date.parse('2026-09-22T00:00:00.000Z');
const job: JobListing = {
  id: '123',
  title: 'Software Engineer',
  company: 'Example Pty Ltd',
  location: 'Sydney NSW',
  url: 'https://www.seek.com.au/job/123',
  platform: 'seek',
  description: 'Build software with React.',
};

function withCache(entries: unknown[], fn: (path: string) => void) {
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
    expiresAt: overrides.disposition === 'external' ? '2026-09-23T00:00:00.000Z' : null,
    contentFingerprint: reviewContentFingerprint(job),
    ...overrides,
  };
}

test('suppresses an unchanged job before another model review', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v1')?.disposition, 'fit-mismatch');
}));

test('unchanged suitability decisions survive seven days and the full access period', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW + 90 * 86400_000, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v1')?.disposition, 'fit-mismatch');
  assert.equal(reviewCacheMetadata(job, 'fit-mismatch', 'candidate-v1', REVIEW_TTL.fit).expiresAt, null);
}));

test('legacy decisions defer behind new jobs but never suppress a full advert without content proof', () => {
  const legacy = createHash('sha256').update(JSON.stringify({ id: job.id, platform: 'seek', title: job.title.toLowerCase(),
    company: job.company.toLowerCase(), teaser: '' })).digest('hex');
  withCache([entry({ listingFingerprint: legacy, contentFingerprint: undefined })], path => {
    const cache = new ReviewCache({ now: NOW, cachePath: path });
    assert.ok(cache.prior(job, 'candidate-v1'));
    assert.equal(cache.suppression(job, 'candidate-v1'), null);
  });
});

test('search cards defer full-description decisions; changed adverts and metadata are reconsidered', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  const { description, ...card } = job;
  assert.ok(cache.prior(card, 'candidate-v1'));
  assert.equal(cache.suppression(card, 'candidate-v1'), null);
  assert.equal(cache.suppression({ ...job, description: 'A changed full description with the same search card.' }, 'candidate-v1'), null);
  for (const changed of [{ location: 'Melbourne' }, { salary: '$100,000' }, { workArrangement: 'Remote' }, { platform: 'indeed' as const }]) {
    assert.equal(cache.prior({ ...job, ...changed }, 'candidate-v1'), null);
  }
  assert.equal(cache.suppression({ ...job, description: '  Build SOFTWARE\nwith React. ' }, 'candidate-v1')?.disposition, 'fit-mismatch');
}));

test('detail enrichment retains the discovery identity without masking content changes', () => {
  const card = { ...job, location: 'Sydney' };
  const detail = { ...job, location: 'Sydney CBD', discoveryFingerprint: listingFingerprint(card) };
  const metadata = reviewCacheMetadata(detail, 'fit-mismatch', 'candidate-v1', null);
  withCache([entry(metadata)], path => {
    const cache = new ReviewCache({ now: NOW, cachePath: path });
    assert.ok(cache.prior(card, 'candidate-v1'));
    assert.ok(cache.suppression(detail, 'candidate-v1'));
    assert.equal(cache.suppression({ ...detail, description: 'New role requirements' }, 'candidate-v1'), null);
  });
});

test('changing discovery keywords does not erase decisions, but preferences and instructions do', () => {
  const savedKeywords = config.keywords, savedInstructions = config.aiInstructions;
  const profile = { name: 'Fixture' } as CandidateProfile;
  try {
    const original = reviewContextFingerprint(profile);
    config.keywords = ['Different search'];
    assert.equal(reviewContextFingerprint(profile), original);
    config.aiInstructions = 'Only remote roles';
    assert.notEqual(reviewContextFingerprint(profile), original);
  } finally { config.keywords = savedKeywords; config.aiInstructions = savedInstructions; }
});

test('resume and knowledge changes invalidate suitability memory; tracking links do not', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-evidence-'));
  const saved = process.env.DATA_DIR;
  const profile = { name: 'Fixture' } as CandidateProfile;
  try {
    process.env.DATA_DIR = directory;
    mkdirSync(join(directory, 'resumes'));
    writeFileSync(join(directory, 'resumes', 'cv.txt'), 'React experience');
    const original = reviewContextFingerprint(profile);
    writeFileSync(join(directory, 'resumes', 'cv.txt'), 'React and TypeScript experience');
    assert.notEqual(reviewContextFingerprint(profile), original);
    const changedResume = reviewContextFingerprint(profile);
    writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([{ text: 'New qualification' }]));
    assert.notEqual(reviewContextFingerprint(profile), changedResume);
    assert.equal(reviewContentFingerprint({ ...job, applicationUrl: 'https://employer.invalid/?tracking=1' }),
      reviewContentFingerprint({ ...job, applicationUrl: 'https://employer.invalid/?tracking=2' }));
  } finally { if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; rmSync(directory, { recursive: true, force: true }); }
});

test('old government-policy rejections no longer suppress a listing', () => withCache([
  { ...entry(), disposition: 'policy', reason: 'Australian government application site excluded.' },
], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression(job, 'candidate-v1'), null);
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

test('relative listing-age text does not invalidate an unchanged job', () => withCache([entry()], path => {
  const cache = new ReviewCache({ now: NOW, cachePath: path });
  assert.equal(cache.suppression({ ...job, listedAt: '2 hours ago' }, 'candidate-v1')?.disposition, 'fit-mismatch');
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
