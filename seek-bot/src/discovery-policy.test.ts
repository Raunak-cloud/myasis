import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveryTarget, nextLowYieldStreak, shouldStopDiscovery } from './discovery-policy.js';

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
