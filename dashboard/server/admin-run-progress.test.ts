import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadAdminRunProgress } from './admin-run-progress.js';

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'admin-run-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directoryFor = (owner: string) => join(root, owner);
  const write = (owner: string, file: string, content: string) => {
    mkdirSync(join(directoryFor(owner), 'run-logs'), { recursive: true });
    writeFileSync(join(directoryFor(owner), file), content);
  };
  return { directoryFor, write };
}

test('live and recorded progress are attributed to the right run and keep genuine zeroes', async t => {
  const { directoryFor, write } = setup(t);
  const health = (runStartId: string, found: number) => ({
    runStartId, reviewed: 0, needsHuman: 2, errors: 1, unconfirmedSubmits: 0,
    search: { found, matched: 0, sources: ['SEEK', 'Indeed'], reviewLimit: 300, filters: { listingAge: 88, privateNote: 3 } },
  });
  write('2', 'run-health.json', JSON.stringify(health('24', 123)));
  write('1', 'run-health.json', JSON.stringify(health('25', 999)));
  const base = { userId: '2', finishedAt: null, running: true, logFile: null, health: null };
  const result = await loadAdminRunProgress([
    { ...base, id: '24' },
    { ...base, id: '25' },
    { ...base, id: '23', finishedAt: '2026-11-25T01:00:00Z', running: false, health: health('23', 0) },
  ], directoryFor);
  assert.deepEqual(result.get('24'), {
    found: 123, reviewed: 0, reviewedEstimated: false, matched: 0, reviewLimit: 300,
    sources: ['SEEK', 'Indeed'], filters: { listingAge: 88 }, needsAttention: 2, errors: 1, unconfirmed: 0,
  });
  assert.equal(result.get('25'), null);
  assert.equal(result.get('23')?.found, 0);
  assert.equal(result.get('23')?.reviewed, 0);
});

test('older run logs provide discovery totals and an explicitly estimated review count', async t => {
  const { directoryFor, write } = setup(t);
  const lines = [
    '  overrides: MAX_EVALUATIONS=300 PLATFORMS=seek,jora',
    'Platforms this run: SEEK, Jora',
    '30 unique listings discovered across 2 platform(s).',
    '  [worker:seek] ✓ 85 · Analyst @ Employer',
    '  ✗ 50 · Different role @ Other Employer',
    '  ✓ 75 · Another Analyst @ Employer',
    '  Review slot restored: Another Analyst @ Employer',
    '151 unique listings discovered across 2 platform(s).',
    'Filtered out:', '   89 × listing age', '   3 × already reviewed', '   1 × recent below-score',
    '   4 × awaiting your confirmation', '1 qualifying jobs.', '  ✗ error: form failed', '  ⏸ needs your answer: input required',
    '=== Run complete: 0 new application(s) ===',
  ];
  write('2', 'run-logs/20.jsonl', lines.map(text => JSON.stringify({ text })).join('\n') + '\n{partial');
  const base = { userId: '2', finishedAt: '2026-11-25T01:00:00Z', running: false, health: null };
  const result = await loadAdminRunProgress([
    { ...base, id: '20', logFile: '20.jsonl' }, { ...base, id: '19', logFile: '19.jsonl' },
  ], directoryFor);
  assert.deepEqual(result.get('20'), {
    found: 151, reviewed: 2, reviewedEstimated: true, matched: 1, reviewLimit: 300,
    sources: ['SEEK', 'Jora'], filters: { listingAge: 89, alreadyReviewed: 4, awaitingConfirmation: 4 },
    needsAttention: 1, errors: 1, unconfirmed: 0,
  });
  assert.equal(result.get('19'), null);
});
