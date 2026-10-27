import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { sampleReplayCorpus } from './replay-sample.mjs';

test('ten-page sample spans platforms, deduplicates owners, rotates by release and preserves source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-sample-'));
  try {
    const owners = ['owner-one', 'owner-two'].map(owner => join(root, owner));
    for (const owner of owners) for (const platform of ['Workday', 'Greenhouse', 'Dayforce', 'PageUp', 'LiveHire']) {
      const dir = join(owner, platform); mkdirSync(dir, { recursive: true });
      for (let n = 0; n < 10; n++) {
        writeFileSync(join(dir, `${n}.json`), JSON.stringify({ platform, host: `${platform.toLowerCase()}.invalid`, capturedAt: '2026-10-27', fields: [] }));
        writeFileSync(join(dir, `${n}.html.gz`), gzipSync(`<form>${platform} ${n}</form>`));
      }
    }
    const sample = sampleReplayCorpus(owners, join(root, 'first'), 10, 'release-one');
    assert.equal(sample.length, 10); assert.equal(new Set(sample).size, 10);
    for (const platform of ['Workday', 'Greenhouse', 'Dayforce', 'PageUp', 'LiveHire']) assert.equal(sample.filter(key => key.startsWith(platform + ':')).length, 2);
    assert.deepEqual(sampleReplayCorpus(owners.slice().reverse(), join(root, 'retry'), 10, 'release-one'), sample);
    assert.notDeepEqual(sampleReplayCorpus(owners, join(root, 'next'), 10, 'release-two'), sample);
    assert.equal(readdirSync(join(root, 'first')).length, 10);
    assert.match(readFileSync(join(owners[0], 'Workday', '0.json'), 'utf8'), /"fields":\[\]/);
    assert.equal(sampleReplayCorpus(owners, join(root, 'all-available'), 100, 'release-one').length, 50);
    writeFileSync(join(owners[0], 'Workday', 'bad.json'), '{broken');
    writeFileSync(join(owners[0], 'Workday', 'bad.html.gz'), 'invalid gzip');
    writeFileSync(join(owners[0], 'Workday', 'bad-body.json'), JSON.stringify({platform:'Workday',host:'workday.invalid'}));
    writeFileSync(join(owners[0], 'Workday', 'bad-body.html.gz'), 'invalid gzip');
    assert.equal(sampleReplayCorpus(owners, join(root, 'with-corrupt'), 10).length, 10);
    assert.equal(sampleReplayCorpus(owners, join(root, 'all-with-corrupt'), 100).length, 50);
    assert.throws(() => sampleReplayCorpus(owners, join(root, 'bad-limit'), 0), /positive integer/);
    assert.throws(() => sampleReplayCorpus(owners, join(root, 'first'), 10), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
