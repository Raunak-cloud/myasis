import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverySearches } from './discovery-search.js';
import { searchUrl as seekUrl } from './discovery.js';
import { searchUrl as indeedUrl } from './discovery-indeed.js';
import { discoveryBatchEnd, shouldStopDiscovery } from './discovery-policy.js';
import type { JobListing } from './types.js';

const address = { location: 'Robertson NSW 2577', radiusKm: 0 };
const preferences = { onsiteCity: 'Wollongong', workArrangements: ['onsite', 'hybrid', 'remote'] };

test('Maria regression: zero address radius still searches her chosen office city and remote roles nationwide', () => {
  const scopes = discoverySearches(address, preferences);
  assert.equal(scopes.length, 2);
  const local = new URL(seekUrl('Student Placement officer', 1, scopes[0]));
  assert.equal(local.searchParams.get('where'), 'Wollongong');
  assert.equal(local.searchParams.get('workarrangement'), '1,2');
  assert.equal(local.searchParams.get('distance'), '0');
  const remote = new URL(seekUrl('Student Operations Officer', 1, scopes[1]));
  assert.equal(remote.searchParams.has('where'), false);
  assert.equal(remote.searchParams.has('distance'), false);
  assert.equal(remote.searchParams.get('workarrangement'), '3');
  assert.equal(new URL(indeedUrl('Student Operations Officer', 1, undefined, scopes[0])).searchParams.get('l'), 'Wollongong');
  assert.equal(new URL(indeedUrl('Student Operations Officer', 1, undefined, scopes[1])).searchParams.get('l'), 'Remote');
});

test('work arrangement selection controls which streams exist', () => {
  for (const selected of [['onsite'], ['hybrid'], ['onsite', 'hybrid'], ['remote']]) {
    const scopes = discoverySearches(address, { ...preferences, workArrangements: selected });
    assert.equal(scopes.length, 1);
    assert.deepEqual(scopes[0].arrangements, selected);
    assert.equal(scopes[0].location, selected[0] === 'remote' ? '' : 'Wollongong');
  }
  const unrestricted = discoverySearches(address, { ...preferences, onsiteCity: '' });
  assert.equal(unrestricted.length, 1);
  assert.equal(unrestricted[0].location, '');
});

test('explicit address distance retains its centre and limit on both boards', () => {
  const scopes = discoverySearches({ ...address, radiusKm: 25 }, preferences);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].location, address.location);
  const seek = new URL(seekUrl('C++ & AI / café', 2, scopes[0]));
  assert.equal(seek.searchParams.get('where'), '2577');
  assert.equal(seek.searchParams.get('distance'), '25');
  assert.equal(seek.searchParams.get('page'), '2');
  assert.equal(seek.searchParams.get('keywords'), 'C++ & AI / café');
  const indeed = new URL(indeedUrl('C++ & AI / café', 2, undefined, scopes[0]));
  assert.equal(indeed.searchParams.get('l'), address.location);
  assert.equal(indeed.searchParams.get('radius'), '25');
  assert.equal(indeed.searchParams.get('start'), '10');
});

test('a missing address does not remove the office-city restriction', () => {
  const scopes = discoverySearches({ location: '', radiusKm: 25 }, preferences);
  assert.equal(scopes[0].location, 'Wollongong');
  assert.equal(scopes[0].radiusKm, 0);
  assert.equal(scopes[1].location, '');
});

test('local exhaustion does not consume a nationwide remote stream or its pagination', () => {
  const scopes = discoverySearches(address, preferences);
  const seen = scopes.map(() => new Set<string>());
  const local: JobListing = { id: 'shared', title: 'Officer', company: 'Fixture', location: 'Wollongong', url: 'https://fixture.invalid', ageDays: 1 };
  assert.equal(discoveryBatchEnd([local], seen[0], 20, true), undefined);
  assert.equal(discoveryBatchEnd([local], seen[0], 20, true), 'repeat');
  assert.equal(discoveryBatchEnd([local], seen[1], 20, true), undefined, 'a duplicate across scopes does not exhaust the other scope');
  assert.equal(shouldStopDiscovery({ promisingJobs: 1, target: 15 }), false);
  assert.equal(new URL(seekUrl('Officer', 2, scopes[1])).searchParams.get('workarrangement'), '3');
  assert.equal(new URL(seekUrl('Officer', 2, scopes[1])).searchParams.has('where'), false);
});
