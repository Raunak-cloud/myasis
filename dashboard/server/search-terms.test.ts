import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitSearchTerms, searchExclusions, suggestResumeSearches, searchTermsRequest, searchReviewRequest } from './search-terms.js';
import { groundGeneratedSearches, reviewedSearches, resumeContextError, MAX_RESUME_CHARS, MAX_COMBINED_RESUME_CHARS } from './resume-search-grounding.js';

const resume = { id: 'cv1', label: 'Administration CV', text: 'Receptionist, West Clinic, 2022-present. Managed patient bookings and billing. Trained new reception staff. Current AHPRA general registration MED000123.' };
const quote = 'Managed patient bookings and billing.';
const generated = (query = 'Medical Receptionist') => ({
  query, matchType: 'direct', reason: 'Your patient bookings and billing experience supports medical reception work.',
  resumeEvidence: [{ resumeId: resume.id, quote }],
  australianCredentialRequired: '', australianCredentialEvidence: { resumeId: '', quote: '' },
});
const accepted = (id: string) => ({ id, supported: true, senioritySupported: true, credentialsSupported: true, distinct: true, matchType: 'direct' });
type Ask = NonNullable<Parameters<typeof suggestResumeSearches>[2]>;

test('only explicit alternatives exclude current and previous suggestions', () => {
  assert.deepEqual(splitSearchTerms('React Developer, Node Engineer'), ['React Developer', 'Node Engineer']);
  assert.deepEqual(searchExclusions({ currentTerms: 'Medical Receptionist', excludeTerms: ['Receptionist'] }), []);
  assert.deepEqual(searchExclusions({ alternatives: true, currentTerms: 'Medical Receptionist', excludeTerms: ['medical-receptionist', 'Receptionist'] }), ['Medical Receptionist', 'Receptionist']);
});

test('PDF wrapping and typography differences preserve source verification', () => {
  assert.equal(groundGeneratedSearches([generated()], [{ ...resume, text: resume.text.replace('patient bookings', 'patient\nbookings') }]).length, 1);
  const candidate = { ...generated(), resumeEvidence: [{ resumeId: 'cv1', quote: "Delivered clients' appointments - independently." }] };
  assert.equal(groundGeneratedSearches([candidate], [{ ...resume, text: 'Delivered clients’ appointments — independently.' }]).length, 1);
});

test('invented, paraphrased, filename-only and cross-account citations are rejected', () => {
  for (const evidence of [
    [{ resumeId: 'cv1', quote: 'Supervised a team of twelve nurses.' }],
    [{ resumeId: 'cv1', quote: 'Managed all patient appointments and invoicing.' }],
    [{ resumeId: 'another-account', quote }], [{ resumeId: 'cv1', quote: resume.label }],
    [{ resumeId: 'cv1', quote }, { resumeId: 'cv1', quote: 'Invented extra skill' }],
    ['Supported by the resume'],
  ]) assert.deepEqual(groundGeneratedSearches([{ ...generated(), resumeEvidence: evidence }], [resume]), []);
});

test('malformed, incomplete and duplicate candidates fail the source gate', () => {
  for (const item of [null, 'Receptionist', {}, { ...generated(), matchType: 'perfect' },
    { ...generated(), reason: '' }, { ...generated(), resumeEvidence: [] },
    { ...generated(), australianCredentialRequired: undefined }]) {
    assert.deepEqual(groundGeneratedSearches([item], [resume]), []);
  }
  const candidates = groundGeneratedSearches([generated('medical-receptionist'), generated(), generated('Office Assistant')], [resume], ['MEDICAL RECEPTIONIST']);
  assert.deepEqual(candidates.map(c => c.query), ['Office Assistant']);
});

test('regulated roles require a credential citation from the selected source', () => {
  const role = { ...generated('Medical Officer'), australianCredentialRequired: 'AHPRA general registration' };
  assert.deepEqual(groundGeneratedSearches([role], [resume]), []);
  assert.deepEqual(groundGeneratedSearches([{ ...role, australianCredentialEvidence: { resumeId: 'cv1', quote: 'Current nursing registration' } }], [resume]), []);
  assert.equal(groundGeneratedSearches([{ ...role, australianCredentialEvidence: { resumeId: 'cv1', quote: 'Current AHPRA general registration MED000123.' } }], [resume]).length, 1);
});

test('real quotes cannot bypass relevance, seniority, credential or diversity review', () => {
  const candidates = groundGeneratedSearches([generated('Senior Data Scientist')], [resume]);
  assert.equal(candidates.length, 1, 'a genuine quote alone does not establish relevance');
  for (const field of ['supported', 'senioritySupported', 'credentialsSupported', 'distinct']) {
    assert.deepEqual(reviewedSearches(candidates, [{ ...accepted('s1'), [field]: false }]), []);
    assert.deepEqual(reviewedSearches(candidates, [{ ...accepted('s1'), [field]: 'true' }]), []);
  }
});

test('review cannot invent candidates, skip checks, duplicate approval or mislabel matches', () => {
  const candidates = groundGeneratedSearches([generated()], [resume]);
  for (const decisions of [[], [accepted('unknown')], [{ id: 's1', supported: true }],
    [accepted('s1'), accepted('s1')], [{ ...accepted('s1'), matchType: 'transferable' }]]) {
    assert.deepEqual(reviewedSearches(candidates, decisions), []);
  }
  assert.equal(reviewedSearches(candidates, [accepted('s1')])[0].query, 'Medical Receptionist');
});

test('direct roles precede adjacent roles and the final shortlist is capped at three', () => {
  const candidates = groundGeneratedSearches(['Office Assistant', 'Medical Receptionist', 'Bookings Officer', 'Reception Team Leader'].map((query, index) => ({
    ...generated(query), matchType: index === 0 ? 'transferable' : 'direct',
  })), [resume]);
  const result = reviewedSearches(candidates, candidates.map(c => ({ ...accepted(c.id), matchType: c.matchType })));
  assert.deepEqual(result.map(c => c.query), ['Medical Receptionist', 'Bookings Officer', 'Reception Team Leader']);
});

test('long resumes fail explicitly before a provider call, never silently drop their end', async () => {
  assert.equal(resumeContextError([resume]), null);
  assert.match(resumeContextError([1, 2, 3].map(id => ({ ...resume, id: String(id), text: 'x'.repeat(MAX_COMBINED_RESUME_CHARS / 3 + 1) }))) ?? '', /Select fewer/);
  const ask: Ask = async () => { throw new Error('must not call provider'); };
  const result = await suggestResumeSearches([{ ...resume, text: 'x'.repeat(MAX_RESUME_CHARS + 1) }], [], ask);
  assert.equal(result.ok, false);
});

test('both calls see full source context; only source-verified candidates reach review', async () => {
  const calls: Array<{ prompt: string; temperature?: number }> = [];
  const ask: Ask = async (_system, prompt, _schema, temperature) => {
    calls.push({ prompt, temperature });
    if (calls.length === 1) return { ok: true, value: { searches: [generated(), { ...generated('Nurse'), resumeEvidence: [{ resumeId: 'cv1', quote: 'Invented qualification' }] }] } };
    assert.ok(prompt.includes(resume.text));
    assert.ok(!prompt.includes('Invented qualification'));
    return { ok: true, value: { decisions: [accepted('s1')] } };
  };
  const result = await suggestResumeSearches([resume], [], ask);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.suggestions[0].evidence, [{ resumeId: 'cv1', resumeLabel: resume.label, quote }]);
  assert.deepEqual(calls.map(c => c.temperature), [0.1, 0]);
});

test('insufficient evidence abstains without another call or forced new role', async () => {
  let calls = 0;
  const ask: Ask = async () => { calls++; return { ok: true, value: { searches: [] } }; };
  assert.deepEqual(await suggestResumeSearches([resume], [], ask), { ok: true, suggestions: [] });
  assert.equal(calls, 1);
});

test('review outage and malformed review never expose unreviewed suggestions', async () => {
  for (const response of [{ ok: false, error: 'Fixture outage' }, { ok: true, value: { other: [] } }]) {
    let calls = 0;
    const ask: Ask = async () => ++calls === 1 ? { ok: true, value: { searches: [generated()] } } : response;
    const result = await suggestResumeSearches([resume], [], ask);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 502);
  }
});

test('structured prompts permit abstention and inspect task context rather than generic skills', () => {
  const request = searchTermsRequest(JSON.stringify([resume]), []);
  const schema = request.schema as { properties: { searches: { minItems: number } } };
  assert.equal(schema.properties.searches.minItems, 0);
  assert.match(request.prompt, /not merely generic communication/);
  assert.match(searchReviewRequest(JSON.stringify([resume]), []).prompt, /negated experience/);
});

test('generation and review receive the same account preferences without leaking them to another request', async () => {
  const instructions = 'Only medical receptionist roles; no nursing roles.';
  let calls = 0;
  const ask: Ask = async (_system, prompt) => {
    assert.ok(prompt.includes(instructions));
    assert.match(prompt, /Alternative searches must remain within these preferences/);
    return ++calls === 1
      ? { ok: true, value: { searches: [generated()] } }
      : { ok: true, value: { decisions: [{ ...accepted('s1'), supported: false }] } };
  };
  assert.deepEqual(await suggestResumeSearches([resume], [], ask, instructions), { ok: true, suggestions: [] });
  assert.equal(calls, 2);
  assert.ok(!searchTermsRequest(JSON.stringify([resume]), []).prompt.includes(instructions));
  assert.ok(!searchReviewRequest(JSON.stringify([resume]), []).prompt.includes(instructions));
});
