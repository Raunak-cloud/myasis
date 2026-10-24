import assert from 'node:assert/strict';
import test from 'node:test';
import { boardAgeWindow, discoveryTarget, nextLowYieldStreak, shouldStopDiscovery } from './discovery-policy.js';
import { parseAgeDays } from './discovery.js';
import { deterministicExclusion } from './scoring.js';
import { config } from './config.js';

test('caps discovery at the smaller review or candidate budget', () => {
  assert.equal(discoveryTarget(80, 24), 24);
  assert.equal(discoveryTarget(10, 12), 10);
});

test('does not stop early until enough promising unseen jobs exist', () => {
  assert.equal(shouldStopDiscovery({ pageNumber: 0, maxPages: 3, promisingJobs: 12, target: 12 }), true);
  assert.equal(shouldStopDiscovery({ pageNumber: 1, maxPages: 3, promisingJobs: 11, target: 12 }), false);
  assert.equal(shouldStopDiscovery({ pageNumber: 1, maxPages: 3, promisingJobs: 12, target: 12 }), true);
  assert.equal(shouldStopDiscovery({ pageNumber: 3, maxPages: 3, promisingJobs: 50, target: 12 }), false);
});

test('two consecutive zero-yield pages stop a search stream', () => {
  let streak = nextLowYieldStreak(0, 0);
  assert.equal(streak, 1);
  streak = nextLowYieldStreak(streak, 0);
  assert.equal(streak, 2);
  assert.equal(nextLowYieldStreak(streak, 1), 0);
});

test('known applications and rejections do not prematurely end discovery', () => {
  assert.equal(nextLowYieldStreak(1, 0, 20), 0);
  assert.equal(nextLowYieldStreak(0, 0, 0), 1);
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
