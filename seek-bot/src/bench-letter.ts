/**
 * Cover letters on Celeris, measured against the ones Gemini actually sent.
 *
 * The comparison set is this account's own applied.json: same jobs, same
 * candidate, and the Gemini letters in there are the ones real employers
 * received. Prose quality is the one thing the fit-check benchmark could not
 * tell us, and it is the highest-stakes output in the system.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, loadProfile } from './config.js';
import { writeCoverLetter, llmMeter } from './llm.js';
import { wordCount } from './humanizer.js';
import type { JobListing } from './types.js';

const profile = loadProfile();
const applied = JSON.parse(readFileSync(resolve(config.dataDir, 'applied.json'), 'utf8')) as Array<{
  jobId: string; title: string; company: string; location: string; coverLetter?: string;
}>;
const cached = JSON.parse(readFileSync(resolve(config.dataDir, 'bench-listings.json'), 'utf8')) as JobListing[];

const targets = applied.filter((a) => a.coverLetter && cached.some((c) => c.id === a.jobId)).slice(-3);
console.log(`comparing ${targets.length} letter(s)\n`);

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
const times: number[] = [];

for (const record of targets) {
  const job = cached.find((c) => c.id === record.jobId)!;
  const t = ms();
  const fresh = await writeCoverLetter(job, profile);
  times.push(ms() - t);

  console.log(`═══ ${record.title} @ ${record.company}`);
  console.log(`  gemini (sent):  ${wordCount(record.coverLetter!)} words`);
  console.log(`  celeris (new):  ${wordCount(fresh)} words · ${times.at(-1)}ms`);
  const named = fresh.toLowerCase().includes(record.company.split(' ')[0].toLowerCase());
  const signed = fresh.toLowerCase().includes(profile.name.split(' ')[0].toLowerCase());
  console.log(`  names employer: ${named}   signs candidate: ${signed}`);
  console.log(`  ── celeris letter ──\n${fresh.split('\n').map((l) => '  ' + l).join('\n')}\n`);
}

const sorted = [...times].sort((a, b) => a - b);
console.log(`celeris letter latency: median ${sorted[Math.floor(sorted.length/2)]}ms  (${times.join(', ')})`);
console.log(`spend: ${llmMeter.summary()}`);
