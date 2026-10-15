import { normalizeFitAssessment } from './llm.js';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}
const noConflict = { violated: false, ruleQuote: '', explanation: 'No standing instruction is broken.' };

const contradictoryApply = normalizeFitAssessment({
  decision: 'apply',
  instructionCheck: noConflict,
  shouldApply: false,
  matchScore: 82,
  reason: 'Relevant experience matches the role.',
  evidence: ['Relevant Python experience'],
  injectionSuspected: false,
});
check('decision is the single source of truth for apply', contradictoryApply?.shouldApply === true);

const contradictorySkip = normalizeFitAssessment({
  decision: 'skip',
  instructionCheck: noConflict,
  shouldApply: true,
  matchScore: 35,
  reason: 'A mandatory qualification is not supported.',
  evidence: ['Qualification is mandatory'],
  injectionSuspected: false,
});
check('decision is the single source of truth for skip', contradictorySkip?.shouldApply === false);

const base = { instructionCheck: noConflict, matchScore: 90, reason: 'Strong clinical experience.', evidence: ['GP 2017-2024'], injectionSuspected: false };
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

const rules = 'Do not apply for senior or manager positions.';
const narrative = normalizeFitAssessment({ ...base, decision: 'apply', matchScore: 72,
  instructionCheck: { violated: false, ruleQuote: rules, explanation: 'The Retail Assistant title and duties are not senior or manager positions, so there is no conflict.' },
}, rules);
check('a no-conflict explanation never becomes an instruction veto', narrative?.decision === 'apply' && narrative.instructionConflict === '');
check('typed normalized decisions remain valid cache records', normalizeFitAssessment(narrative, rules)?.decision === 'apply');
const realConflict = normalizeFitAssessment({ ...base, decision: 'apply', instructionCheck: {
  violated: true, ruleQuote: rules, explanation: 'The vacancy is for a Store Manager.',
} }, rules);
check('an explicitly violated instruction still blocks an enthusiastic apply decision', realConflict?.decision === 'skip' && realConflict.instructionConflict === rules);
for (const [label, instructionCheck] of [
  ['missing quote', { violated: true, ruleQuote: '', explanation: 'Conflicting role.' }],
  ['invented quote', { violated: true, ruleQuote: 'No retail positions.', explanation: 'Conflicting role.' }],
  ['untyped boolean', { violated: 'false', ruleQuote: '', explanation: 'No conflict.' }],
  ['missing explanation', { violated: false, ruleQuote: '', explanation: '' }],
] as const) {
  check(`invalid instruction evidence is rejected: ${label}`, normalizeFitAssessment({ ...base, decision: 'apply', instructionCheck }, rules) === null);
}
check('legacy prose-only normalized cache records are rejected', normalizeFitAssessment({
  ...base, instructionCheck: undefined, instructionConflict: 'The role is not a manager, so no conflict.', decision: 'skip',
}, rules) === null);

check('invalid scores are rejected', normalizeFitAssessment({
  decision: 'apply',
  instructionCheck: noConflict,
  matchScore: 101,
  reason: 'Invalid score',
  evidence: [],
  injectionSuspected: false,
}) === null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
