import { resolveAttention, type RunEventRow } from './attention.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const event = (status: string, minute: number): RunEventRow => ({
  job_id: 'job-1',
  status,
  title: 'Example role',
  company: 'Example employer',
  reason: status,
  url: 'https://example.test/job-1',
  ts: `2026-09-12T10:${String(minute).padStart(2, '0')}:00.000Z`,
  questions: [],
});

check(
  'a later resolved event clears an older blocker',
  resolveAttention([event('needs-human', 1), event('already-applied', 2)], new Set()).length === 0,
);
check(
  'a later blocker remains visible',
  resolveAttention([event('skipped', 1), event('needs-human', 2)], new Set()).length === 1,
);
check(
  'an application record clears all blockers for that job',
  resolveAttention([event('needs-human', 1)], new Set(['job-1'])).length === 0,
);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
