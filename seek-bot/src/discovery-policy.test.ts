import assert from 'node:assert/strict';
import test from 'node:test';
import { boardAgeWindow, discoveryBatchEnd, discoveryTarget, shouldStopDiscovery } from './discovery-policy.js';
import { parseAgeDays } from './discovery.js';
import { searchUrl as seekSearchUrl } from './discovery.js';
import { searchUrl as indeedSearchUrl } from './discovery-indeed.js';
import { listingAgeDays, withinListingAge } from './listing-age.js';
import type { JobListing } from './types.js';
import { deterministicExclusion } from './scoring.js';
import { config } from './config.js';

test('caps discovery at the smaller review or candidate budget', () => {
  assert.equal(discoveryTarget(80, 24), 24);
  assert.equal(discoveryTarget(10, 12), 10);
});

test('does not stop early until enough promising unseen jobs exist', () => {
  assert.equal(shouldStopDiscovery({ promisingJobs: 11, target: 12 }), false);
  assert.equal(shouldStopDiscovery({ promisingJobs: 12, target: 12 }), true);
});

test('age-window discovery continues beyond six short batches, ending only on age, exhaustion or repeats', () => {
  const seen = new Set<string>();
  const listing = (id: string, ageDays?: number): JobListing => ({ id, title: 'Role', company: 'Employer', location: 'Sydney', url: 'https://fixture.invalid', ageDays });
  for (let batch = 1; batch <= 8; batch++) assert.equal(discoveryBatchEnd([listing(String(batch), 20)], seen, 20, true), undefined);
  assert.equal(discoveryBatchEnd([listing('old', 21)], seen, 20, true), 'age');
  assert.equal(discoveryBatchEnd([listing('unordered-old', 21)], seen, 20, false), undefined);
  assert.equal(discoveryBatchEnd([listing('unknown')], seen, 20, true), undefined);
  assert.equal(discoveryBatchEnd([listing('unknown')], seen, 20, true), 'repeat');
  assert.equal(discoveryBatchEnd([], seen, 20, true), 'end');
});

test('age-window queries always carry a date filter and use newest-first ordering', () => {
  const previous = config.rules.maxAgeDays;
  try {
    for (const limit of [1, 14, 20, 30]) {
      config.rules.maxAgeDays = limit;
      const seek = new URL(seekSearchUrl('developer', 9));
      const indeed = new URL(indeedSearchUrl('developer', 9));
      assert.ok(Number(seek.searchParams.get('daterange')) >= limit);
      assert.equal(seek.searchParams.get('sortmode'), 'ListedDate');
      assert.equal(indeed.searchParams.get('fromage'), String(limit + 1));
      assert.equal(indeed.searchParams.get('sort'), 'date');
    }
  } finally { config.rules.maxAgeDays = previous; }
});

test('listing-age evidence rejects unknown and future publication dates before matching', () => {
  assert.equal(withinListingAge({}, 20), false);
  assert.equal(withinListingAge({ ageDays: 20 }, 20), true);
  assert.equal(withinListingAge({ ageDays: 21 }, 20), false);
  assert.equal(listingAgeDays({ listedAt: '2026-10-28T00:00:00Z', ageDays: 0 }, Date.parse('2026-10-27T00:00:00Z')), undefined);
  assert.ok(deterministicExclusion({ id: 'unknown', title: 'Role', company: 'Employer', location: 'Sydney', url: 'https://fixture.invalid' }, true));
});

test('board age window rounds up to an offered window, never down', () => {
  assert.equal(boardAgeWindow(14, [1, 3, 7, 14, 31]), 14);
  assert.equal(boardAgeWindow(10, [1, 3, 7, 14, 31]), 14);
  assert.equal(boardAgeWindow(0, [1, 3, 7, 14]), 1);
  assert.equal(boardAgeWindow(20, [1, 3, 7, 14]), undefined);
  assert.equal(boardAgeWindow(Number.NaN, [1, 3, 7, 14]), undefined);
});

test('relative dates distinguish minutes, months and years, including older-than labels', () => {
  for (const [text, days] of [
    ['54m ago•Viewed', 0], ['3 mins ago', 0], ['2 hours ago', 0], ['3d ago', 3],
    ['48 hours ago', 2], ['1440 minutes ago', 1],
    ['Posted 2 days ago', 2], ['2 weeks ago', 14], ['3w ago', 21],
    ['1 month ago', 30], ['2 months ago', 60], ['2mo ago', 60], ['1 yr ago', 365],
    ['30+ days ago', 31], ['30d+ ago', 31], ['More than 30 days ago', 31],
    ['Over 4 weeks ago', 29], ['Yesterday', 1], ['Posted today', 0],
  ] as const) assert.equal(parseAgeDays(text), days, text);
  for (const text of [undefined, '', 'Date not provided', 'Hiring 3 managers']) {
    assert.equal(parseAgeDays(text), undefined, text);
  }
});

test('listing-age boundaries reject old month and plus labels without rejecting the exact maximum', () => {
  const previous = config.rules.maxAgeDays;
  try {
    for (const limit of [20, 30]) {
      config.rules.maxAgeDays = limit;
      for (const [text, excluded] of [
        [`${limit} days ago`, false], [`${limit + 1} days ago`, true],
        [`${limit}+ days ago`, true], ['2 months ago', true],
        ['1 month ago', limit < 30],
      ] as const) {
        const result = deterministicExclusion({ id: 'age-fixture', title: 'Fixture', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid', ageDays: parseAgeDays(text) });
        assert.equal(Boolean(result), excluded, `${limit}-day maximum: ${text}`);
      }
    }
  } finally { config.rules.maxAgeDays = previous; }
});
