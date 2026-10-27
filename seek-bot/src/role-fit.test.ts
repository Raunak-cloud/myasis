import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFitAssessment } from './llm.js';
import { roleFitError } from './role-fit.js';

const candidate = 'Full-Stack Developer and AI & Automation Engineer. Builds web applications and LLM integrations.';
const job = { id: 'synthetic-audiences', title: 'Senior Specialist, Synthetic Audience', company: 'Fixture', location: 'Sydney', url: 'https://fixture.invalid',
  description: 'You are a strong UX researcher who brings deep research judgment, methodological rigor, and customer empathy to AI-enabled work.' };
const role = { alignment: 'mismatch' as const, employerEvidence: job.description,
  candidateEvidence: 'Full-Stack Developer and AI & Automation Engineer.', explanation: 'The primary work is UX research, while the candidate seeks development and AI engineering. Shared AI tools alone do not establish research experience.' };
const assessment = { decision: 'apply', matchScore: 85, reason: 'AI tools overlap.', evidence: [], injectionSuspected: false,
  instructionCheck: { violated: false, ruleQuote: '', explanation: 'No standing instructions.' }, workArrangementCheck: { offered: [], evidence: '' }, roleFitCheck: role };

test('a high score cannot override a model-identified primary-work mismatch', () => {
  assert.equal(roleFitError(role, job, candidate), null);
  const result = normalizeFitAssessment(assessment, '', ['onsite', 'hybrid', 'remote']);
  assert.equal(result?.decision, 'skip'); assert.equal(result?.shouldApply, false);
  assert.match(result!.reason, /primary work is UX research/);
});

test('role evidence must come from the actual listing and candidate documents', () => {
  assert.ok(roleFitError(undefined, job, candidate));
  assert.ok(roleFitError({ ...role, employerEvidence: 'Invented duty.' }, job, candidate));
  assert.ok(roleFitError({ ...role, alignment: 'aligned', candidateEvidence: 'Ten years of UX research.' }, job, candidate));
  assert.ok(roleFitError({ ...role, alignment: 'aligned', candidateEvidence: '' }, job, candidate));
  const supported = { ...role, alignment: 'aligned', employerEvidence: 'Builds web applications', explanation: 'The developer duties align.' };
  assert.equal(roleFitError(supported, { ...job, description: 'Builds web applications' }, candidate), null);
  assert.equal(normalizeFitAssessment({ ...assessment, roleFitCheck: supported }, '', ['onsite', 'hybrid', 'remote'])?.decision, 'apply');
});
