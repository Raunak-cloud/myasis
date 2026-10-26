import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-fit-contract-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { config } = await import('./config.js');
const { assessFit } = await import('./llm.js');
config.aiInstructions = 'Do not apply for manager positions.';
config.resume.select = 'fit-fixture-cv';
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Retail customer service experience.\n' + 'Unrelated supporting detail. '.repeat(900) + '\nCREDENTIAL_TAIL_FIXTURE');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fit-fixture-cv', label: 'Fixture CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Current clearance', answer: 'SAVED_CANDIDATE_FACT_FIXTURE' }]));
const originalFetch = globalThis.fetch;
let mode = 'allow', calls = 0, corrections = 0;
globalThis.fetch = async (_url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  const schema = body.response_format.json_schema.schema;
  let value: unknown;
  if (schema.properties.checks) {
    value = { checks: [{ ruleQuote: config.aiInstructions, status: mode === 'real-conflict' ? 'violated' : 'satisfied',
      reason: mode === 'real-conflict' ? 'This is a Store Manager vacancy.' : 'This is a frontline assistant vacancy.',
      exceptionQuote: '', exceptionConditions: [] }], injectionSuspected: false };
  } else {
    assert.ok(schema.properties.instructionCheck, 'the provider receives a typed instruction contract');
    assert.ok(schema.properties.workArrangementCheck, 'arrangements are extracted before the approval decision');
    assert.match(body.messages[0].content, /FULL CANDIDATE PROFILE/);
    assert.match(body.messages[0].content, /CREDENTIAL_TAIL_FIXTURE/, 'the matcher reads the complete ordinary CV, including facts beyond the former short excerpt');
    assert.match(body.messages[0].content, /SAVED_CANDIDATE_FACT_FIXTURE/);
    assert.match(body.messages[0].content, /MATCHING-STAGE DUPLICATE DECISION/);
    assert.match(body.messages[0].content, /"decision":"clear"/);
    assert.match(body.messages[0].content, /UNCERTAIN ATTEMPTS FOR THIS POSTING/);
    assert.equal(schema.properties.instructionConflict, undefined, 'prose cannot encode a blocking decision');
    const correction = String(body.messages[0].content).includes('DECISION CONTRACT CORRECTION');
    if (correction) { corrections++; assert.equal(body.model, 'celeris-1-magnus'); }
    const malformed = mode === 'invalid-twice' || mode === 'repair' && !correction;
    value = {
      workArrangementCheck: { offered: ['onsite'], evidence: 'Casual retail assistant.' },
      opportunityEvidence: 'A genuine current casual Retail Assistant vacancy.',
      instructionCheck: malformed
        ? { violated: true, ruleQuote: '', explanation: 'A conflict without traceable evidence is invalid.' }
        : { violated: false, ruleQuote: config.aiInstructions, explanation: 'The title is not manager and no instruction is broken.' },
      credentialChecks: [], decision: 'apply', matchScore: 72,
      reason: 'Frontline retail evidence fits the casual work, and the disclosed hourly rate exceeds the hourly floor.',
      evidence: ['Retail duties match', 'Casual hourly role'], injectionSuspected: false,
    };
    assert.match(body.messages[0].content, /Unknown\s+pay is neutral/);
    assert.match(body.messages[0].content, /do not also require annual earnings/i);
    assert.match(body.messages[0].content, /Availability across several shift windows does not mean unlimited hours/);
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
};
const profile = { name: 'Fixture Candidate', phone: '', email: 'fixture@example.test', nationality: 'Limited permitted work hours',
  expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: 'Retail service and a previous career in another field.',
  skills: ['Customer service'], excludedDomains: [], securityClearance: '' };
const job = { id: 'allowed', title: 'Retail Assistant', company: 'Fixture Shop', location: 'Sydney',
  description: 'Casual retail assistant. $35 per hour. Product familiarity is desirable; training is provided.', url: 'https://fixture.invalid/job' };
try {
  const allowed = await assessFit(job, profile);
  assert.equal(allowed.shouldApply, true, 'a no-conflict narrative cannot erase an otherwise approved fit');
  assert.equal(allowed.instructionConflict, '');
  assert.equal(allowed.instructionCheck?.violated, false);
  const paidCalls = calls;
  assert.equal((await assessFit(job, profile)).shouldApply, true);
  assert.equal(calls, paidCalls, 'typed normalized fit records remain reusable without another request');

  mode = 'repair';
  assert.equal((await assessFit({ ...job, id: 'repair', description: `${job.description} Fixture scenario: repair.` }, profile)).shouldApply, true);
  assert.equal(corrections, 1, 'invalid conflict evidence gets one bounded deeper correction');
  mode = 'invalid-twice';
  await assert.rejects(assessFit({ ...job, id: 'invalid-twice', description: `${job.description} Fixture scenario: invalid twice.` }, profile), /typed decision schema after correction/);
  assert.equal(corrections, 2, 'a second invalid response fails closed rather than making more attempts');
  mode = 'real-conflict';
  const beforeConflict = calls;
  const blocked = await assessFit({ ...job, id: 'real-conflict', title: 'Store Manager' }, profile);
  assert.equal(blocked.shouldApply, false);
  assert.equal(blocked.instructionCheck?.violated, true);
  assert.equal(calls - beforeConflict, 1, 'a genuine instruction exclusion still prevents the fit request');
  console.log('PASS: typed no-conflict decision, reusable normalized cache, bounded contract correction, invalid evidence fail-closed and real instruction exclusions. All model calls mocked.');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-contract-'));
  rmSync(directory, { recursive: true, force: true });
}
