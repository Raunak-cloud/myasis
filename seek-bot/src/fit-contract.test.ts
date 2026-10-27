import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-fit-contract-'));
process.env.DATA_DIR = directory;
process.env.CELERIS_API_KEY = 'fixture-only';
const { config } = await import('./config.js');
const { assessFit, fitAssessmentValidationError } = await import('./llm.js');
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
  const userPrompt = body.messages.find((message: { role: string }) => message.role === 'user').content;
  const schema = body.response_format.json_schema.schema;
  let value: unknown;
  if (schema.properties.checks) {
    value = { checks: [{ ruleQuote: config.aiInstructions, status: mode === 'real-conflict' ? 'violated' : 'satisfied',
      reason: mode === 'real-conflict' ? 'This is a Store Manager vacancy.' : 'This is a frontline assistant vacancy.',
      exceptionQuote: '', exceptionConditions: [] }], injectionSuspected: false };
  } else {
    assert.equal(schema.properties.instructionCheck, undefined, 'the instruction reviewer owns the sole instruction decision');
    assert.equal(schema.required.includes('instructionCheck'), false);
    assert.ok(schema.properties.workArrangementCheck, 'arrangements are extracted before the approval decision');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /MATCHING SOURCE AUTHORITY/);
    assert.match(body.messages[0].content, new RegExp(JSON.stringify(config.aiInstructions).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(userPrompt, /FULL CANDIDATE PROFILE/);
    assert.match(userPrompt, /CREDENTIAL_TAIL_FIXTURE/, 'the matcher reads the complete ordinary CV, including facts beyond the former short excerpt');
    assert.match(userPrompt, /SAVED_CANDIDATE_FACT_FIXTURE/);
    assert.match(userPrompt, /MATCHING-STAGE DUPLICATE DECISION/);
    assert.match(userPrompt, /"decision":"clear"/);
    assert.match(userPrompt, /UNCERTAIN ATTEMPTS FOR THIS POSTING/);
    assert.equal(schema.properties.instructionConflict, undefined, 'prose cannot encode a blocking decision');
    const correction = String(userPrompt).includes('DECISION CONTRACT CORRECTION');
    if (correction) {
      corrections++; assert.equal(body.model, 'celeris-1-magnus');
      assert.match(userPrompt, /failed this specific check: matchScore/);
    }
    assert.equal(schema.properties.matchScore.minimum, 0);
    assert.equal(schema.properties.matchScore.maximum, 100);
    const stale = (mode === 'stale-repair' && !correction) || mode === 'stale-twice';
    const malformed = mode === 'invalid-twice' || mode === 'repair' && !correction;
    value = {
      workArrangementCheck: { offered: ['onsite'], evidence: 'Casual retail assistant.' },
      opportunityEvidence: 'A genuine current casual Retail Assistant vacancy.',
      instructionCheck: stale
        ? { violated: true, ruleQuote: 'Do not apply for senior positions or manager positions.', explanation: 'Copied an obsolete instruction from an old saved question.' }
        : malformed
        ? { violated: true, ruleQuote: '', explanation: 'A conflict without traceable evidence is invalid.' }
        : { violated: false, ruleQuote: config.aiInstructions, explanation: 'The title is not manager and no instruction is broken.' },
      credentialChecks: [], decision: 'apply', matchScore: malformed ? 101 : 72,
      reason: 'Frontline retail evidence fits the casual work, and the disclosed hourly rate exceeds the hourly floor.',
      evidence: ['Retail duties match', 'Casual hourly role'], injectionSuspected: false,
    };
    assert.match(userPrompt, /Unknown\s+pay is neutral/);
    assert.match(userPrompt, /do not also require annual earnings/i);
    assert.match(userPrompt, /Availability across several shift windows does not mean unlimited hours/);
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
  await assert.rejects(assessFit({ ...job, id: 'invalid-twice', description: `${job.description} Fixture scenario: invalid twice.` }, profile), /job match could not be verified/);
  assert.equal(corrections, 2, 'a second invalid response fails closed rather than making more attempts');
  mode = 'real-conflict';
  const beforeConflict = calls;
  const blocked = await assessFit({ ...job, id: 'real-conflict', title: 'Store Manager' }, profile);
  assert.equal(blocked.shouldApply, false);
  assert.equal(blocked.instructionCheck?.violated, true);
  assert.equal(calls - beforeConflict, 1, 'a genuine instruction exclusion still prevents the fit request');
  config.aiInstructions = '';
  const staleAnswer = { question: 'The candidate previously instructed: Do not apply for senior positions or manager positions. Proceed with this Web Design Lead role?', answer: 'No' };
  writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Current clearance', answer: 'SAVED_CANDIDATE_FACT_FIXTURE' }, staleAnswer]));
  mode = 'stale-repair';
  const beforeStale = corrections;
  const recovered = await assessFit({ ...job, id: 'stale-repair', description: `${job.description} Stale rule fixture.` }, profile);
  assert.equal(recovered.decision, 'apply');
  assert.equal(recovered.instructionCheck?.ruleQuote, '');
  assert.equal(corrections, beforeStale, 'a fabricated second instruction verdict is not requested or promoted over the current instruction review');
  assert.match(fitAssessmentValidationError({ ...recovered, instructionCheck: { violated: true, ruleQuote: 'Obsolete restriction', explanation: 'A saved question mentions it.' } })!, /CURRENT standing instructions/);
  mode = 'stale-twice';
  assert.equal((await assessFit({ ...job, id: 'stale-twice', description: `${job.description} Invalid stale rule twice.` }, profile)).shouldApply, true);
  const diagnostics = readFileSync(join(directory, 'pipeline-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.stage === 'fit-contract-invalid');
  assert.ok(diagnostics.some(row => row.jobId === 'invalid-twice' && row.attempt === 2 && /matchScore/.test(row.error)));
  assert.equal(diagnostics.some(row => JSON.stringify(row).includes(staleAnswer.question)), false, 'diagnostics record failed paths without leaking candidate answers');
  console.log('PASS: current-source instruction schema, bounded field-specific repair, private diagnostics, cache reuse, stale-rule rejection and genuine instruction exclusions. All model calls mocked.');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-contract-'));
  rmSync(directory, { recursive: true, force: true });
}
