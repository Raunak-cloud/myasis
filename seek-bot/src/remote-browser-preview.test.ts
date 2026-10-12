import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRemoteBrowserPreview, REMOTE_PREVIEW_FILE } from './remote-browser-preview.js';

test('preview never reads another account or presents an expired, partial or oversized frame', () => {
  const directory = mkdtempSync(join(tmpdir(), 'owtomate-preview-fixture-'));
  const second = mkdtempSync(join(tmpdir(), 'owtomate-preview-fixture-'));
  try {
    const now = Date.now();
    const frame = { sessionId: randomUUID(), provider: 'brightdata', at: now, url: 'https://jobs.example.test', data: 'YWJj' };
    const file = join(directory, REMOTE_PREVIEW_FILE);
    writeFileSync(file, JSON.stringify(frame));
    assert.deepEqual(readRemoteBrowserPreview(directory, now), frame);
    assert.equal(readRemoteBrowserPreview(second, now), null);
    assert.equal(readRemoteBrowserPreview(directory, now + 8_001), null);
    for (const override of [{ at: now + 2_000 }, { url: 'wss://secret@service.test' }, { data: '<script>' }]) {
      writeFileSync(file, JSON.stringify({ ...frame, ...override })); assert.equal(readRemoteBrowserPreview(directory, now), null);
    }
    writeFileSync(file, '{'); assert.equal(readRemoteBrowserPreview(directory, now), null);
    writeFileSync(file, 'x'.repeat(4_000_001)); assert.equal(readRemoteBrowserPreview(directory, now), null);
  } finally { rmSync(directory, { recursive: true }); rmSync(second, { recursive: true }); }
});
