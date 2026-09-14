import { plainReason, resolveAttention, type RunEventRow } from './attention.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const event = (status: string, minute: number, questions: unknown[] = []): RunEventRow => ({
  job_id: 'job-1',
  status,
  title: 'Example role',
  company: 'Example employer',
  reason: status,
  url: 'https://example.test/job-1',
  ts: `2026-09-12T10:${String(minute).padStart(2, '0')}:00.000Z`,
  questions,
});

check(
  'a later resolved event clears an older blocker',
  resolveAttention([event('needs-human', 1, ['Required answer']), event('already-applied', 2)], new Set()).length === 0,
);
check(
  'a later critical question remains visible',
  resolveAttention([event('skipped', 1), event('needs-human', 2, ['Required answer'])], new Set()).length === 1,
);
check(
  'an application record clears all blockers for that job',
  resolveAttention([event('needs-human', 1, ['Required answer'])], new Set(['job-1'])).length === 0,
);
check(
  'technical needs-human events do not ask the candidate to intervene',
  resolveAttention([event('needs-human', 1)], new Set()).length === 0,
);
check(
  'errors and off-platform outcomes do not enter Needs attention',
  resolveAttention([event('error', 1), event('off-platform', 2)], new Set()).length === 0,
);
check(
  'internal browser field refs never reach user-facing reasons',
  plainReason('The mandatory street address field (f7) is not in the candidate profile.') ===
    'The mandatory street address field is not in the candidate profile.',
);

const prompted = resolveAttention([
  event('needs-human', 1, [{
    question: 'Tell us more',
    prompt: 'Describe yourself and explain why you are interested in this role.',
    kind: 'textarea',
  }]),
], new Set());
check(
  'candidate-facing prompts survive attention normalisation',
  prompted[0]?.questions?.[0]?.prompt === 'Describe yourself and explain why you are interested in this role.',
);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
