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
    if (String(userPrompt).includes('APPROVAL EVIDENCE REVIEW')) assert.equal(body.model, 'celeris-1-magnus', 'only a deeper matching review can finalize a proposed approval');
    if (correction) {
      corrections++; assert.equal(body.model, 'celeris-1-magnus');
      assert.match(userPrompt, /failed this specific check: (?:matchScore|roleFitCheck)/);
    }
    assert.equal(schema.properties.matchScore.minimum, 0);
    assert.equal(schema.properties.matchScore.maximum, 100);
    const stale = (mode === 'stale-repair' && !correction) || mode === 'stale-twice';
    const malformed = mode === 'invalid-twice' || mode === 'repair' && !correction;
    value = {
      roleFitCheck: { alignment: 'aligned', employerEvidence: 'Casual retail assistant.',
        candidateEvidence: mode === 'invented-role-evidence' && !correction ? 'Ten years of specialist UX research.' : 'Retail customer service experience.',
        explanation: 'The primary retail service duties match saved CV experience.' },
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
    if (mode === 'approval-rejected' && String(userPrompt).includes('APPROVAL EVIDENCE REVIEW')) value = {
      ...(value as object), roleFitCheck: { alignment: 'mismatch', employerEvidence: 'You are a strong UX researcher.',
        candidateEvidence: 'Retail customer service experience.', explanation: 'The primary UX research requirement is not supported by the retail CV.' },
    };
    if (mode === 'formatted-skip' || mode === 'formatted-apply') value = {
      ...(value as object), decision: mode === 'formatted-skip' ? 'skip' : 'apply',
      roleFitCheck: {
        alignment: mode === 'formatted-skip' ? 'mismatch' : 'aligned',
        employerEvidence: mode === 'formatted-skip' ? 'Assess communication skills. Provide clinical therapy.' : 'Advise customers. Maintain stock.',
        candidateEvidence: 'Retail customer service experience.',
        explanation: mode === 'formatted-skip' ? 'Clinical work is unsupported by the retail CV.' : 'The retail duties match the CV.',
      },
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
  mode = 'invented-role-evidence';
  const beforeEvidenceRepair = corrections;
  assert.equal((await assessFit({ ...job, id: 'invented-role-evidence', description: `${job.description} Grounding fixture.` }, profile)).shouldApply, true);
  assert.equal(corrections, beforeEvidenceRepair + 1, 'an invented candidate qualification must be corrected against actual CV evidence before approval');
  mode = 'approval-rejected';
  const changedJob = { ...job, id: 'approval-rejected', description: `${job.description} You are a strong UX researcher.` };
  const beforeApprovalReview = calls;
  assert.equal((await assessFit(changedJob, profile)).decision, 'skip', 'the final matcher review can reject an optimistic fast-model approval');
  assert.equal(calls - beforeApprovalReview, 2, 'with no standing instructions, matching uses at most a fast assessment plus one final approval review');
  const afterApprovalReview = calls;
  assert.equal((await assessFit(changedJob, profile)).decision, 'skip');
  assert.equal(calls, afterApprovalReview, 'the final reviewed decision is cached without repeating either matching call');
  for (const scenario of ['formatted-skip', 'formatted-apply']) {
    mode = scenario;
    const before: number = calls, repairs: number = corrections;
    const result = await assessFit({ ...job, id: scenario, description: scenario === 'formatted-skip'
      ? 'Assess communication skills\nProvide clinical therapy' : 'Advise customers\nMaintain stock' }, profile);
    assert.equal(result.decision, scenario === 'formatted-skip' ? 'skip' : 'apply');
    assert.equal(corrections, repairs, 'source formatting must not trigger a paid contract correction');
    assert.equal(calls - before, scenario === 'formatted-skip' ? 1 : 2, 'normal approval review remains; valid rejections need only one call');
  }
  const diagnostics = readFileSync(join(directory, 'pipeline-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.stage === 'fit-contract-invalid');
  assert.ok(diagnostics.some(row => row.jobId === 'invalid-twice' && row.attempt === 2 && /matchScore/.test(row.error)));
  assert.equal(diagnostics.some(row => JSON.stringify(row).includes(staleAnswer.question)), false, 'diagnostics record failed paths without leaking candidate answers');
  console.log('PASS: current-source instruction schema, bounded field-specific repair, private diagnostics, cache reuse, stale-rule rejection and genuine instruction exclusions. All model calls mocked.');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-contract-'));
  rmSync(directory, { recursive: true, force: true });
}
