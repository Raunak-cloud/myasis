import assert from 'node:assert/strict';
import { normalizeFitAssessment } from './llm.js';

const base = { decision: 'apply', matchScore: 85, reason: 'Final agent judgment.', evidence: ['Agent-owned evidence.'], injectionSuspected: false };
// These deliberately inconsistent diagnostics prove that code cannot silently
// turn a final agent decision into another one. Resolving them belongs to Magnus.
for (const diagnostic of [
  {},
  { roleFitCheck: { alignment: 'mismatch', employerEvidence: 'Paraphrased duties.', candidateEvidence: '', explanation: 'Diagnostic.' } },
  { workArrangementCheck: { offered: ['hybrid'], evidence: 'Hybrid schedule.' } },
  { workArrangementCheck: { offered: [], evidence: '' } },
  { instructionCheck: { violated: true, ruleQuote: 'Paraphrased rule.', explanation: 'Diagnostic.' } },
  { credentialChecks: [{ mandatory: true, status: 'not-held', requirement: 'Registration', candidateEvidence: '' }] },
  { credentialChecks: [{ mandatory: true, status: 'unclear', requirement: 'Licence', candidateEvidence: '' }] },
  { injectionSuspected: true },
]) for (const decision of ['apply', 'skip', 'uncertain']) {
  const raw = { ...base, ...diagnostic, decision, shouldApply: decision !== 'apply' };
  const result = normalizeFitAssessment(raw);
  assert.equal(result?.decision, decision);
  assert.equal(result?.shouldApply, decision === 'apply');
  assert.equal(result?.reason, raw.reason);
}
for (const malformed of [null, 'apply', { ...base, decision: 'maybe' }, { ...base, matchScore: 101 }, { ...base, evidence: 'prose' }]) {
  assert.equal(normalizeFitAssessment(malformed), null, 'Malformed transport output is never treated as an approval.');
}
console.log('PASS: final agent decisions survive all diagnostic fields unchanged; malformed transport output is rejected.');
