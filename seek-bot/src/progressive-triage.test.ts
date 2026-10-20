import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressiveTriage, progressiveSearchBatch } from './progressive-triage.js';

type Job = { id: string; platform: string; priority: number };
const queue = () => new ProgressiveTriage<Job>({ key: j => j.id, group: j => j.platform, compare: (a, b) => b.priority - a.priority });

test('first window is available without ranking an entire large employer snapshot', () => {
  const q = queue();
  q.add(Array.from({ length: 2000 }, (_, i) => ({ id: `${i}`, platform: 'lever', priority: i })));
  const first = q.take();
  assert.equal(first.length, 24);
  assert.equal(first[0].priority, 1999);
  assert.equal(q.size, 1976, 'the unranked backlog is retained, not discarded');
  assert.equal(q.take().length, 24, 'a failed first window can be replenished');
});

test('large feeds cannot starve another source and duplicate discovery consumes no new slot', () => {
  const q = queue();
  const large = Array.from({ length: 500 }, (_, i) => ({ id: `large-${i}`, platform: 'lever', priority: i }));
  q.add(large);
  q.add([{ id: 'small', platform: 'workday', priority: 0 }]);
  q.add(large);
  assert.equal(q.size, 501);
  assert.ok(q.take(2).some(job => job.id === 'small'));
  const all = q.take(1000);
  assert.equal(all.length, 499);
  assert.equal(new Set(all.map(job => job.id)).size, 499);
  assert.equal(q.size, 0);
});

test('new sources and refills remain usable after earlier queues are exhausted', () => {
  const q = queue();
  q.add([{ id: 'one', platform: 'seek', priority: 0 }]);
  q.take();
  q.add([{ id: 'two', platform: 'greenhouse', priority: 0 }]);
  assert.deepEqual(q.take().map(job => job.id), ['two']);
  q.add([{ id: 'three', platform: 'seek', priority: 0 }]);
  assert.deepEqual(q.take().map(job => job.id), ['three']);
});

test('background discovery cannot touch browser adapters and never overlaps a source with itself', () => {
  const streams = [
    { source: 'seek', api: false, pages: 0 },
    { source: 'lever', api: true, pages: 0 },
    { source: 'lever', api: true, pages: 0 },
    { source: 'workday', api: true, pages: 0 },
  ];
  const options = { source: (s: typeof streams[number]) => s.source, api: (s: typeof streams[number]) => s.api,
    available: () => true, preferApi: true, apiOnly: true };
  assert.deepEqual(progressiveSearchBatch(streams, options).map(s => s.source), ['lever', 'workday']);
  assert.deepEqual(progressiveSearchBatch(streams.filter(s => !s.api), options), []);
  streams[1].pages = 1;
  streams[3].pages = 1;
  assert.equal(progressiveSearchBatch(streams, { ...options, apiOnly: false })[0].source, 'seek', 'a source not searched yet gets a turn before repeated terms');
});
