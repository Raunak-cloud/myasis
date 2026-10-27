import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** Spread a bounded replay across form platforms instead of the first account's
 * first ten pages. A release seed rotates coverage while keeping retries stable. */
export function sampleReplayCorpus(dirs, output, limit = 10, seed = '') {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Replay limit must be a positive integer.');
  const records = new Map();
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && entry.name.endsWith('.json') && existsSync(path.replace(/\.json$/, '.html.gz'))) {
        try {
          const expectation = JSON.parse(readFileSync(path, 'utf8'));
          if (typeof expectation.platform !== 'string' || typeof expectation.host !== 'string') continue;
          const key = `${expectation.platform}:${expectation.host}:${basename(path)}`;
          const previous = records.get(key);
          if (!previous || String(expectation.capturedAt) > previous.capturedAt) records.set(key, {
            key, path, platform: expectation.platform, capturedAt: String(expectation.capturedAt),
          });
        } catch { /* Unreadable metadata cannot represent a usable recorded page. */ }
      }
    }
  }
  dirs.forEach(scan);
  const rank = value => createHash('sha256').update(`${seed}:${value}`).digest('hex');
  const groups = new Map();
  for (const record of [...records.values()].sort((a, b) => rank(a.key).localeCompare(rank(b.key)))) {
    if (!groups.has(record.platform)) groups.set(record.platform, []);
    groups.get(record.platform).push(record);
  }
  const families = [...groups.keys()].sort((a, b) => rank(a).localeCompare(rank(b)));
  mkdirSync(output, { mode: 0o700 }); // A fresh destination; never overwrite the real corpus.
  const selected = [];
  while (selected.length < limit && families.some(family => groups.get(family).length)) {
    for (const family of families) {
      if (selected.length === limit) break;
      const queue = groups.get(family);
      while (queue.length) {
        const record = queue.shift();
        const html = record.path.replace(/\.json$/, '.html.gz');
        try { gunzipSync(readFileSync(html)); } catch { continue; }
        const target = join(output, String(selected.length));
        mkdirSync(target, { mode: 0o700 });
        for (const path of [record.path, html]) {
          const destination = join(target, basename(path));
          copyFileSync(path, destination);
          chmodSync(destination, 0o600);
        }
        selected.push(record.key);
        break;
      }
    }
  }
  return selected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, rawLimit, seed, ...dirs] = process.argv.slice(2);
  if (!output || !dirs.length || !/^[1-9]\d*$/.test(rawLimit || '')) {
    console.error('usage: node deploy/replay-sample.mjs <fresh output directory> <limit> <release seed> <corpus dir>...');
    process.exit(2);
  }
  const selected = sampleReplayCorpus(dirs, output, Number(rawLimit), seed);
  console.log(`replay: selected ${selected.length} representative form pages (limit ${rawLimit})`);
}
