import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_QUESTION_POLICY, PERSONAL_FACT_EVIDENCE_RULES, PROFESSIONAL_ANSWER_EVIDENCE_RULES } from '../application-answer-policy.js';
import { AGENT_ONLY_PROMPT } from './application-policy.js';

test('the actual applying prompt and answer helpers share the authorised employment inference and other declaration rules', () => {
  const rule = 'For prior employment at a named employer, review the supplied resume and employment history and answer No if that employer is not listed and no other candidate evidence says otherwise.';
  for (const policy of [APPLICATION_QUESTION_POLICY, PERSONAL_FACT_EVIDENCE_RULES, AGENT_ONLY_PROMPT]) {
    assert.ok(policy.includes(rule));
    assert.ok(policy.includes('This employment-history inference is authorised; it does not extend to criminal, medical, financial or other unrelated declarations.'));
    assert.ok(policy.includes('No or None needs an explicit candidate statement'));
    assert.ok(policy.includes('Preserve an actually offered and permitted non-disclosure choice for optional unknowns'));
  }
});

test('professional narrative grounding reaches the actual browser writer and answer helpers', () => {
  for (const policy of [APPLICATION_QUESTION_POLICY, AGENT_ONLY_PROMPT]) {
    assert.ok(policy.includes(PROFESSIONAL_ANSWER_EVIDENCE_RULES), 'the canonical rule must be wired into both decision paths');
  }
  assert.ok(APPLICATION_QUESTION_POLICY.includes('basis=composed'));
  assert.ok(APPLICATION_QUESTION_POLICY.includes('Technical uncertainty, missing narrative detail and browser failures do not belong in Needs attention.'));
});
