import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationWorkerEnvironment } from './application-worker-policy.js';
test('only server-enabled admin live runs may request two workers', () => {
  assert.deepEqual(applicationWorkerEnvironment(true, 'live', 'true'), { APPLICATION_WORKERS: '2' });
  for (const [admin, mode, enabled] of [[false, 'live', 'true'], [true, 'search', 'true'], [true, 'live', undefined], [true, 'live', '2']] as const) {
    assert.deepEqual(applicationWorkerEnvironment(admin, mode, enabled), { APPLICATION_WORKERS: '1' });
  }
});
