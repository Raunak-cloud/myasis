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
  assert.equal(roleFitError({ ...role, employerEvidence: '“You are a strong UX researcher … customer empathy to AI-enabled work.”' }, job, candidate), null);
  assert.ok(roleFitError({ ...role, employerEvidence: 'You are a strong UX researcher ... Invented requirement' }, job, candidate));
  assert.equal(normalizeFitAssessment({ ...assessment, roleFitCheck: supported }, '', ['onsite', 'hybrid', 'remote'])?.decision, 'apply');
});

test('employer bullet points and CV formatting can be quoted as sentences without a paid repair', () => {
  const listing = { ...job, description: "Assess participants' communication and swallowing / feeding skills\n• Provide therapy for a range of ages and clinical areas" };
  const cv = 'Full-stack developer who builds products\nComfortable across JavaScript and Python';
  assert.equal(roleFitError({ ...role,
    employerEvidence: "Assess participants’ communication and swallowing / feeding skills. Provide therapy for a range of ages and clinical areas.",
    candidateEvidence: 'Full-stack developer who builds products. Comfortable across JavaScript and Python.',
  }, listing, cv), null);
  assert.equal(roleFitError({ ...role, employerEvidence: 'Assess participants\' communication ... Provide therapy for a range of ages and clinical areas' }, listing, candidate), null);
});

test('formatting tolerance never invents words, numbers, technical skills or contractions', () => {
  for (const [source, quote] of [
    ['Requires C++ experience', 'Requires C experience'],
    ['Requires C# experience', 'Requires C++ experience'],
    ['Requires 3.5 years experience', 'Requires 35 years experience'],
    ['Requires 3+ years experience', 'Requires 3 years experience'],
    ['Score -1', 'Score 1'],
    ["Candidate can't drive", 'Candidate can drive'],
    ['Retail experience', 'tail experience'],
    ['Assess communication skills', 'Assess advanced communication skills'],
  ]) assert.ok(roleFitError({ ...role, employerEvidence: quote }, { ...job, description: source }, candidate), `${source} cannot support ${quote}`);
});
