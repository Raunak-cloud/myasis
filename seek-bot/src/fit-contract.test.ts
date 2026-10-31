import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-fit-contract-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
const { config } = await import('./config.js');
const { assessFit } = await import('./llm.js');
config.aiInstructions = 'Do not apply for manager positions.';
config.resume.select = 'fixture-cv';
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), 'Retail customer service experience.\n' + 'Supporting detail. '.repeat(900) + '\nCV_TAIL_FIXTURE');
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'fixture-cv', label: 'Fixture CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'answers.json'), JSON.stringify([{ question: 'Current clearance', answer: 'SAVED_FACT_FIXTURE' }]));
writeFileSync(join(directory, 'review-history.jsonl'), [
  {jobId: 'other-board-id', title: 'Retail Assistant', company: 'Fixture', status: 'skipped', reason: 'RELATED_DISCLOSED_PAY_FIXTURE: advertised annual salary is $55,000.', ts: new Date().toISOString()},
  {jobId: 'different-employer', title: 'Retail Assistant', company: 'Other Employer', status: 'skipped', reason: 'UNRELATED_EMPLOYER_FIXTURE', ts: new Date().toISOString()},
  {jobId: 'different-role', title: 'Retail Manager', company: 'Fixture', status: 'skipped', reason: 'UNRELATED_ROLE_FIXTURE', ts: new Date().toISOString()},
].map(row => JSON.stringify(row)).join('\n'));
const originalFetch = globalThis.fetch;
let mode = 'apply', calls = 0;
globalThis.fetch = async (_url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body)), prompt = body.messages.find((m: { role: string }) => m.role === 'user').content;
  assert.equal(body.model, 'celeris-1-magnus', 'Every final fit decision belongs to Magnus.');
  assert.equal(body.response_format.json_schema.schema.properties.checks, undefined, 'No preliminary instruction classifier.');
  assert.match(body.messages[0].content, /sole matching decision maker/);
  for (const evidence of ['FULL CANDIDATE PROFILE', 'CV_TAIL_FIXTURE', 'SAVED_FACT_FIXTURE', config.aiInstructions, 'minimum match score', 'MATCHING-STAGE DUPLICATE DECISION']) assert.ok(prompt.includes(evidence), evidence);
  assert.ok(prompt.includes('RELATED_DISCLOSED_PAY_FIXTURE'), 'a different board ID must not hide related disclosed pay from the matching agent');
  assert.doesNotMatch(prompt, /UNRELATED_EMPLOYER_FIXTURE|UNRELATED_ROLE_FIXTURE/, 'unrelated employers and roles cannot supply matching evidence');
  const correction = prompt.includes('RESPONSE FORMAT CORRECTION');
  const result = { decision: mode === 'skip' ? 'skip' : mode === 'uncertain' ? 'uncertain' : 'apply',
    matchScore: mode === 'invalid-twice' || mode === 'repair' && !correction ? 101 : 85,
    reason: 'Agent final judgment.', evidence: ['Paraphrased source evidence'], injectionSuspected: false,
    roleFitCheck: { alignment: 'aligned', employerEvidence: 'Retail service duties.', candidateEvidence: 'Customer service background.', explanation: 'Agent judgment.' },
    instructionCheck: { violated: false, ruleQuote: '', explanation: 'The role is not a manager position.' },
  };
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
};
const profile = { name: 'Fixture', phone: '', email: 'fixture@example.test', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
  experienceSummary: 'Retail service.', skills: ['Customer service'], excludedDomains: [], securityClearance: '' };
const job = { id: 'fixture', title: 'Retail Assistant', company: 'Fixture', location: 'Sydney', description: 'Serve customers\nMaintain stock', url: 'https://fixture.invalid/job' };
try {
  for (const decision of ['apply', 'skip', 'uncertain']) {
    mode = decision;
    const before: number = calls;
    assert.equal((await assessFit({ ...job, id: decision }, profile)).decision, decision);
    assert.equal(calls - before, 1, 'A valid Magnus decision uses one request, including evidence paraphrases.');
  }
  mode = 'apply'; const cached: number = calls;
  assert.equal((await assessFit({ ...job, id: 'apply' }, profile)).shouldApply, true);
  assert.equal(calls, cached, 'The final decision is reused without another review.');
  mode = 'repair'; const before: number = calls;
  assert.equal((await assessFit({ ...job, id: 'repair' }, profile)).decision, 'apply');
  assert.equal(calls - before, 2, 'Only malformed output gets one format retry.');
  mode = 'invalid-twice'; const invalid: number = calls;
  await assert.rejects(assessFit({ ...job, id: 'invalid' }, profile), /usable decision after a format retry/);
  assert.equal(calls - invalid, 2);
  const metrics = readFileSync(join(directory, 'pipeline-metrics.jsonl'), 'utf8');
  assert.doesNotMatch(metrics, /SAVED_FACT_FIXTURE|Retail service/);
  console.log('PASS: one Magnus decision, complete evidence/preferences, no quote veto, cache reuse and bounded format repair. All provider calls mocked.');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-contract-'));
  rmSync(directory, { recursive: true, force: true });
}
