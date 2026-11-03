import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { roleFitProvenanceError, type FitProvenanceSources, type RoleFitCheck, type CurrentOccupationIntent, type PrimaryWorkOutput } from './role-fit.js';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-fit-intent-'));
Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', COST_TRACKING: 'false' });
const { config } = await import('./config.js');
const { assessFit, normalizeFitAssessment } = await import('./llm.js');
const { withApplicationModel } = await import('./application-model.js');
const originalFetch = globalThis.fetch;
const bounded = 'Seek data analytics, business intelligence and data governance work, including combined Business & Data Analyst roles whose primary outputs are data products. Keep this current career direction.';
const oldLetter = 'I am interested in Business Analysis and broad business transformation opportunities.';
const capability = 'Led analytics delivery, reporting requirements, stakeholder workshops, validation, adoption and data quality improvements.';
config.resume.select = 'intent-cv';
mkdirSync(join(directory, 'resumes'));
writeFileSync(join(directory, 'resumes', 'CV.txt'), capability);
writeFileSync(join(directory, 'resumes.json'), JSON.stringify([{ id: 'intent-cv', label: 'Fixture CV', fileName: 'CV.txt', isDefault: true }]));
writeFileSync(join(directory, 'knowledge.json'), JSON.stringify([{ id: 'old-letter', kind: 'note', label: 'Older general cover letter', text: oldLetter, enabled: true }]));
const profile = { name: 'Fixture', phone: '', email: 'fixture@example.test', nationality: '', expectedSalary: '', noticePeriod: '', willingToRelocate: false,
  experienceSummary: capability, skills: ['Data analysis', 'Business intelligence', 'Workshops'], excludedDomains: [], securityClearance: '' };
const cases = [
  { id: 'systems-adjacency', title: 'Finance Business Analyst', duties: 'Gather functional specifications for a finance-system implementation and own UAT and go-live.',
    expected: 'skip', relationship: 'capability-only', mapping: 'System implementation and UAT are the primary outputs. Shared requirements and workshop capability does not authorize leaving the current data-product function.' },
  { id: 'process-adjacency', title: 'Business Analyst', duties: 'Redesign operational business processes, run change workshops and lead adoption of new workflows.',
    expected: 'skip', relationship: 'outside-intent', mapping: 'The central output is changed operational workflows, not the data products currently requested. A general older letter cannot broaden that current boundary.' },
  { id: 'supporting-administration', title: 'Analytics Team Administrator', duties: 'Maintain the analytics team payroll, order software subscriptions and schedule its staff. Analysts produce the data products.',
    expected: 'skip', relationship: 'supporting-work', mapping: 'Administration supports the requested analytics team but does not itself perform the requested data-product function.' },
  { id: 'combined-data-function', title: 'Business & Data Analyst', duties: 'Translate business reporting needs into governed data models, dashboards and data-quality measures.',
    expected: 'apply', relationship: 'requested-work', mapping: 'The primary outputs are data models, dashboards and quality measures serving the explicitly requested combined business-and-data function.' },
  { id: 'governance-function', title: 'Business Data Steward', duties: 'Define business glossary and data ownership, implement data-quality controls and coordinate stewardship.',
    expected: 'apply', relationship: 'requested-work', mapping: 'Definitions, data ownership, quality controls and stewardship are the requested data-governance outputs despite process and stakeholder work.' },
  { id: 'explicit-career-change', title: 'Process Improvement Analyst', duties: 'Redesign operational business processes and support adoption of new workflows.',
    instruction: 'Apply for process-improvement analyst work focused on redesigning business workflows; I want this career change from analytics.',
    expected: 'apply', relationship: 'requested-work', mapping: 'The current explicit career-change instruction positively authorizes these process-redesign outputs; an older occupation does not veto it.' },
  { id: 'open-intent', title: 'Operations Analyst', duties: 'Investigate operational information and help stakeholders improve service delivery.', instruction: '',
    expected: 'apply', relationship: 'requested-work', mapping: 'No current occupation boundary is set. The agent evaluates relevant capabilities without inventing a data-only restriction.' },
  { id: 'missing-description', title: 'Data Analyst', duties: '', expected: 'uncertain', relationship: 'uncertain', mapping: 'No employer duties were supplied; there is no primary output to quote.' },
  { id: 'no-duties-in-description', title: 'Data Analyst', duties: 'Apply online.', expected: 'uncertain', relationship: 'uncertain', mapping: 'The supplied text has no actual duties. Preserve uncertainty instead of inventing a data deliverable.' },
] as const;
let active: typeof cases[number], calls = 0, mode = 'valid';
function roleForCurrentCase(): RoleFitCheck & { currentIntent: CurrentOccupationIntent; primaryOutputs: PrimaryWorkOutput[] } {
  return { alignment: active.expected === 'apply' ? 'aligned' : active.expected === 'uncertain' ? 'uncertain' : 'mismatch', employerEvidence: 'The agent identifies the primary employer function from its deliverables.',
    candidateEvidence: capability, explanation: active.mapping,
    currentIntent: { scope: active.id === 'open-intent' ? 'open' : 'bounded', source: active.id === 'open-intent' ? 'none' : 'current-standing-instructions',
      quote: active.id === 'open-intent' ? '' : config.aiInstructions, requestedWork: active.id === 'open-intent' ? 'No explicit occupation restriction.' : config.aiInstructions },
    primaryOutputs: active.expected === 'uncertain' ? [] : [{ output: active.duties, employerQuote: active.duties, relationship: active.relationship, mapping: active.mapping }] };
}
globalThis.fetch = async (url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, 'celeris-1-magnus');
  assert.equal(String(url).includes('openrouter.ai'), false, 'fit always uses Magnus independently of the applying selection');
  const prompt = body.messages.find((message: { role: string }) => message.role === 'user').content;
  assert.match(body.messages[0].content, /sole matching decision maker/);
  assert.match(prompt, /Current bounded intent governs over an older or broader/);
  assert.match(prompt, /discarding its defining qualifier/);
  assert.match(prompt, /Search keywords define requested job functions/);
  assert.ok(prompt.includes(oldLetter) && prompt.includes(active.duties));
  const schema = body.response_format.json_schema.schema.properties.roleFitCheck;
  assert.ok(schema.required.includes('currentIntent') && schema.required.includes('primaryOutputs'));
  assert.ok(!schema.properties.currentIntent.properties.source.enum.includes('cover-letter'));
  assert.equal(schema.properties.currentIntent.properties.quote, undefined);
  assert.equal(schema.properties.primaryOutputs.items.properties.employerQuote, undefined);
  const correction = prompt.includes('RESPONSE FORMAT CORRECTION');
  const role = roleForCurrentCase();
  const { quote: _quote, ...currentIntent } = role.currentIntent;
  const employerIds = schema.properties.primaryOutputs.items.properties.employerPassageId.enum;
  const wire = { ...role, currentIntent: { ...currentIntent, passageId: active.id === 'open-intent' ? '' : schema.properties.currentIntent.properties.passageId.enum[1] },
    primaryOutputs: role.primaryOutputs.map(({ employerQuote: _employerQuote, ...output }) => ({ ...output, employerPassageId: employerIds[0] })) };
  if (mode === 'misattributed' && !correction) wire.currentIntent.passageId = employerIds[0];
  if (mode === 'invented-employer') wire.primaryOutputs[0].employerPassageId = 'p_invented_employer';
  return Response.json({ choices: [{ message: { content: JSON.stringify({ decision: active.expected, matchScore: active.expected === 'apply' ? 85 : 25,
    reason: active.mapping, evidence: ['Agent-owned fit judgment.'], injectionSuspected: false, instructionCheck: {violated:false,ruleQuote:'',explanation:'Current requested work assessed.'}, roleFitCheck: wire }) } }], usage: { prompt_tokens: 100, completion_tokens: 150 } });
};
try {
  for (const model of ['celeris', 'minimax']) await withApplicationModel({ DATA_DIR: directory, APPLICATION_AI_MODEL: model, OPENROUTER_API_KEY: 'fixture-only', CELERIS_API_KEY: 'fixture-only' }, async () => {
    for (const fixture of cases) {
      active = fixture; mode = 'valid';
      config.aiInstructions = 'instruction' in fixture ? fixture.instruction : bounded;
      config.targetRole = ''; config.keywords = [];
      const job = { id: `${model}-${fixture.id}`, title: fixture.title, company: 'Synthetic employer', location: 'Sydney', description: fixture.duties, url: `https://fixture.invalid/${fixture.id}` };
      const before = calls, result = await assessFit(job, profile);
      assert.equal(result.decision, fixture.expected); assert.equal(calls - before, 1, 'one existing fitter call for a valid response; no second reviewer');
      assert.equal(result.roleFitCheck?.currentIntent?.quote, config.aiInstructions, 'canonical stored evidence is dereferenced from the exact current source');
      if (result.roleFitCheck?.primaryOutputs?.length) assert.equal(result.roleFitCheck.primaryOutputs[0].employerQuote, fixture.duties);
      if (result.decision !== 'uncertain') { const cacheCalls = calls; await assessFit(job, profile); assert.equal(calls, cacheCalls, 'new provenance-qualified decisions remain cacheable'); }
    }
    active = cases[0]; config.aiInstructions = bounded;
    mode = 'misattributed'; const before = calls;
    assert.equal((await assessFit({ id: `${model}-wrong-intent-source`, title: active.title, company: 'Synthetic employer', location: 'Sydney', description: active.duties, url: 'https://fixture.invalid/source' }, profile)).decision, 'skip');
    assert.equal(calls - before, 2, 'misattributed provenance uses only the existing bounded format correction');
    mode = 'invented-employer'; const invalid = calls;
    await assert.rejects(assessFit({ id: `${model}-invented-duty`, title: active.title, company: 'Synthetic employer', location: 'Sydney', description: active.duties, url: 'https://fixture.invalid/duty' }, profile), /usable decision after a format retry/);
    assert.equal(calls - invalid, 2, 'ungrounded employer evidence cannot add an unbounded retry or another semantic classifier');
    active = cases[0]; mode = 'valid';
    const sourceJob = { id: `${model}-source-change`, title: active.title, company: 'Synthetic employer', location: 'Sydney', description: active.duties, url: 'https://fixture.invalid/source-change' };
    await assessFit(sourceJob, profile);
    const sourceCalls = calls;
    await assessFit(sourceJob, profile); assert.equal(calls, sourceCalls);
    config.aiInstructions = bounded + ' Avoid night shifts.';
    const revised = await assessFit(sourceJob, profile);
    assert.equal(calls, sourceCalls + 1, 'changing current preference source invalidates low-level transport cache');
    assert.equal(revised.roleFitCheck?.currentIntent?.quote, config.aiInstructions);
    const changedJob = { ...sourceJob, description: sourceJob.description + ' Preserve the current employer qualifier.' };
    const revisedEmployer = await assessFit(changedJob, profile);
    assert.equal(calls, sourceCalls + 2, 'changing supplied employer evidence also invalidates low-level transport cache');
    assert.equal(revisedEmployer.roleFitCheck?.primaryOutputs?.[0].employerQuote, changedJob.description);
  });
  active = cases[0]; config.aiInstructions = bounded;
  const sources: FitProvenanceSources = { 'current-standing-instructions': bounded, 'current-target-role': 'Data governance', 'current-search-preferences': 'Business & Data Analyst', employerText: active.duties };
  const valid = roleForCurrentCase(); assert.equal(roleFitProvenanceError(valid, sources), null);
  assert.equal(roleFitProvenanceError({ ...valid, alignment: 'uncertain', primaryOutputs: [] }, { ...sources, employerText: '' }), null, 'missing employer duties remain representable without invented evidence');
  assert.match(roleFitProvenanceError({ ...valid, alignment: 'aligned', primaryOutputs: [] }, sources) ?? '', /at least one evidenced primary output/);
  assert.match(roleFitProvenanceError({ ...valid, primaryOutputs: [{ ...valid.primaryOutputs[0], employerQuote: ' \n ' }] }, sources) ?? '', /nonempty employer evidence/);
  assert.match(roleFitProvenanceError({ ...valid, currentIntent: { ...valid.currentIntent, source: 'current-target-role' } }, sources) ?? '', /selected current preference source/);
  assert.match(roleFitProvenanceError({ ...valid, currentIntent: { scope: 'open', source: 'none', quote: '', requestedWork: 'Assumed unrestricted work.' } }, sources) ?? '', /available current preference source/);
  const openSources = { ...sources, 'current-standing-instructions': 'Avoid night shifts.', 'current-target-role': '', 'current-search-preferences': '' };
  assert.equal(roleFitProvenanceError({ ...valid, currentIntent: { scope: 'open', source: 'current-standing-instructions', quote: 'Avoid night shifts.', requestedWork: 'No occupation boundary; preserve the shift preference.' } }, openSources), null, 'a nonempty current setting is not automatically an occupation allowlist');
  const rawLegacy = { decision: 'apply', matchScore: 85, reason: 'Historical diagnostic.', evidence: [], injectionSuspected: false, instructionCheck: {violated:false,ruleQuote:'',explanation:'Current requested work assessed.'},
    roleFitCheck: { alignment: 'aligned', employerEvidence: '', candidateEvidence: '', explanation: '' } };
  const retained = JSON.stringify(rawLegacy); assert.equal(normalizeFitAssessment(rawLegacy, sources), null); assert.equal(JSON.stringify(rawLegacy), retained, 'legacy evidence is rejected as a fresh fit without rewriting historical bytes');
  const inconsistent = { ...rawLegacy, roleFitCheck: valid };
  assert.equal(normalizeFitAssessment(inconsistent, sources), null, 'an aligned/apply decision cannot contradict bounded primary-output mappings');
  const supporting = { ...valid, alignment: 'aligned', primaryOutputs: [{ ...valid.primaryOutputs[0], relationship: 'supporting-work', mapping: 'This separate occupation supports the requested team.' }] };
  assert.equal(normalizeFitAssessment({ ...rawLegacy, roleFitCheck: supporting }, sources), null, 'a supporting function cannot be promoted into bounded occupation permission by an apply/aligned claim');
  const metrics = readFileSync(join(directory, 'pipeline-metrics.jsonl'), 'utf8');
  assert.doesNotMatch(metrics, /I am interested in Business Analysis|Gather functional specifications/);
  console.log('PASS: synthetic systems/process adjacency and real combined-data/governance/career-change/open-intent contracts; grounded current/JD provenance, legacy nonmutation, selected-provider single-pass/cache behavior and bounded malformed provenance correction. Scripted providers do not prove future model judgment.');
} finally {
  globalThis.fetch = originalFetch;
  const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep + 'owtomate-fit-intent-'));
  rmSync(target, { recursive: true, force: true });
}
