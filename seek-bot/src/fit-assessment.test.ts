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

const base = { matchScore: 90, reason: 'Strong clinical experience.', evidence: ['GP 2017-2024'], injectionSuspected: false };
const unregistered = normalizeFitAssessment({
  ...base, decision: 'apply',
  credentialChecks: [{ requirement: 'AHPRA general registration', mandatory: true, candidateEvidence: 'MBBS Nepal only', status: 'not-held' }],
});
check('a mandatory Australian credential not held rules the job out, whatever the fit', unregistered?.decision === 'skip' && /AHPRA/.test(unregistered.reason));
const unclearCredential = normalizeFitAssessment({
  ...base, decision: 'apply',
  credentialChecks: [{ requirement: 'WA electrical licence', mandatory: true, candidateEvidence: 'Licence mentioned without a state', status: 'unclear' }],
});
check('an unclear mandatory credential holds the job for clarification', unclearCredential?.decision === 'uncertain');
const registered = normalizeFitAssessment({
  ...base, decision: 'apply',
  credentialChecks: [{ requirement: 'AHPRA general registration', mandatory: true, candidateEvidence: 'Current AHPRA general registration', status: 'held' }],
});
check('a held credential leaves the model decision alone', registered?.decision === 'apply');
const desirable = normalizeFitAssessment({
  ...base, decision: 'apply',
  credentialChecks: [{ requirement: 'CPA desirable', mandatory: false, candidateEvidence: 'ICAI only', status: 'not-held' }],
});
check('a desirable credential never rules a job out', desirable?.decision === 'apply');

check('invalid scores are rejected', normalizeFitAssessment({
  decision: 'apply',
  matchScore: 101,
  reason: 'Invalid score',
  evidence: [],
  injectionSuspected: false,
}) === null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
