/** Success rate of the AuthorMist pass on this account's real sent letters. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { humanizeCoverLetter, wordCount } from './humanizer.js';

const applied = JSON.parse(readFileSync(resolve(config.dataDir, 'applied.json'), 'utf8')) as Array<{
  title: string; company: string; coverLetter?: string;
}>;
const letters = applied.filter((a) => a.coverLetter && wordCount(a.coverLetter) > 80).slice(-4);
const REPEATS = 3;

let ok = 0, fell = 0;
const times: number[] = [];
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

for (const record of letters) {
  for (let i = 0; i < REPEATS; i++) {
    const t = ms();
    const out = await humanizeCoverLetter(record.coverLetter!);
    times.push(ms() - t);
    const changed = out.trim() !== record.coverLetter!.trim();
    if (changed) ok++; else fell++;
    process.stdout.write(changed ? '✓' : '✗');
  }
  process.stdout.write(` ${record.company.slice(0, 30)}\n`);
}

const sorted = [...times].sort((a, b) => a - b);
console.log(`\nhumanized: ${ok}/${ok + fell}  ·  fell back to original: ${fell}`);
console.log(`latency median ${sorted[Math.floor(sorted.length / 2)]}ms`);
