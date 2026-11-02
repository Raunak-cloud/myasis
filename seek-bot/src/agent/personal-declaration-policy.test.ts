import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_QUESTION_POLICY, PERSONAL_FACT_EVIDENCE_RULES } from '../application-answer-policy.js';
import { AGENT_ONLY_PROMPT } from './application-policy.js';

test('the actual applying prompt and answer helpers share the negative-declaration evidence rule', () => {
  const rule = 'A resume omission, an empty answer bank, a default form value or an earlier unconfirmed agent entry is not evidence of a negative declaration.';
  for (const policy of [APPLICATION_QUESTION_POLICY, PERSONAL_FACT_EVIDENCE_RULES, AGENT_ONLY_PROMPT]) {
    assert.ok(policy.includes(rule));
    assert.ok(policy.includes('No or None needs an explicit candidate statement'));
    assert.ok(policy.includes('Preserve an actually offered and permitted non-disclosure choice for optional unknowns'));
  }
});
