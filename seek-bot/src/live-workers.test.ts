import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLiveWorkers, LIVE_WORKERS_FILE, readLiveTarget, readLiveWorkers, resetLiveWorkers, writeLiveTarget } from './live-workers.js';
import { currentApplicationWorker, withApplicationWorker } from './application-workers.js';

test('worker identity survives asynchronous work, targets stay separate and new runs clear old state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-workers-'));
  const other = mkdtempSync(join(tmpdir(), 'live-workers-'));
  try {
    resetLiveWorkers(directory);
    configureLiveWorkers(directory, ['seek', 'indeed']);
    await Promise.all((['seek', 'indeed'] as const).map(id => withApplicationWorker(id, async () => {
      await Promise.resolve();
      assert.equal(currentApplicationWorker(), id);
      writeLiveTarget(directory, id, { targetId: `page-${id}` });
    })));
    assert.equal(currentApplicationWorker(), 'main');
    assert.equal(readLiveTarget(directory, 'seek')?.targetId, 'page-seek');
    assert.equal(readLiveTarget(directory, 'indeed')?.targetId, 'page-indeed');
    assert.equal(readLiveTarget(other, 'seek'), null);
    assert.equal(readLiveWorkers(other).length, 1);
    assert.deepEqual(readLiveWorkers(directory).map(worker => worker.id), ['seek', 'indeed']);
    writeLiveTarget(directory, 'seek', { finished: true });
    assert.equal(readLiveTarget(directory, 'indeed')?.targetId, 'page-indeed');
    resetLiveWorkers(directory);
    assert.equal(readLiveTarget(directory, 'seek'), null);
    assert.deepEqual(readLiveWorkers(directory).map(worker => worker.id), ['main']);
    for (const workers of [['../other-account'], ['seek', 'seek'], ['__proto__'], []]) {
      writeFileSync(join(directory, LIVE_WORKERS_FILE), JSON.stringify({ workers }));
      assert.equal(readLiveWorkers(directory)[0].id, 'main');
    }
  } finally { rmSync(directory, { recursive: true }); rmSync(other, { recursive: true }); }
});
