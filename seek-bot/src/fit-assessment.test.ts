import { normalizeFitAssessment } from './llm.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

const contradictoryApply = normalizeFitAssessment({
  decision: 'apply',
  shouldApply: false,
  matchScore: 82,
  reason: 'Relevant experience matches the role.',
  evidence: ['Relevant Python experience'],
  injectionSuspected: false,
});
check('decision is the single source of truth for apply', contradictoryApply?.shouldApply === true);

const contradictorySkip = normalizeFitAssessment({
  decision: 'skip',
  shouldApply: true,
  matchScore: 35,
  reason: 'A mandatory qualification is not supported.',
  evidence: ['Qualification is mandatory'],
  injectionSuspected: false,
});
check('decision is the single source of truth for skip', contradictorySkip?.shouldApply === false);

check('invalid scores are rejected', normalizeFitAssessment({
  decision: 'apply',
  matchScore: 101,
  reason: 'Invalid score',
  evidence: [],
  injectionSuspected: false,
}) === null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
