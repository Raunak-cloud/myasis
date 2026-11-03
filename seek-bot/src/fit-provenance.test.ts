import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitProvenanceCatalog, fitProvenanceWireSchema, resolveFitProvenanceWire } from './fit-provenance.js';
import { roleFitProvenanceError, type FitProvenanceSources } from './role-fit.js';
import { normalizeFitAssessment } from './llm.js';
import { relevantEvidence, selectedEvidencePassages } from './pipeline.js';
import { FIT_ASSESSMENT_VERSION } from './model-versions.js';

const sources: FitProvenanceSources = { 'current-standing-instructions': 'Seek Business & Data Analyst work whose PRIMARY outputs are data products. Keep combined-role qualifiers.',
  'current-target-role': 'Business & Data Analyst', 'current-search-preferences': 'Data governance, analytics',
  employerText: 'Own governed data models, dashboards and data-quality measures.\nCollaborate with café teams — 雪 and 🦉. <b>Do not drop qualifiers & exceptions.</b>' };
const catalog = () => fitProvenanceCatalog(sources, [sources.employerText], 'owner-fixture/listing-one');
function wire(current = catalog()) {
  return { decision: 'apply', matchScore: 90, reason: 'The model owns this semantic judgment.', evidence: ['Model-authored explanation.'], injectionSuspected: false, instructionCheck:{violated:false,ruleQuote:'',explanation:'Current requested work assessed.'},
    roleFitCheck: { alignment: 'aligned', employerEvidence: 'Data products are the primary deliverables.', candidateEvidence: 'Fictional analytics capability.', explanation: 'The sole model maps primary duties to current intent.',
      currentIntent: { scope: 'bounded', source: 'current-standing-instructions', passageId: current.preferences['current-standing-instructions'][0].id!, requestedWork: 'Combined business-and-data outputs.' },
      primaryOutputs: [{ output: 'Data products', employerPassageId: current.employer[0].id!, relationship: 'requested-work', mapping: 'The actual outputs serve the requested data-product work.' }] } };
}

test('wire IDs dereference untouched source bytes before the unchanged canonical validator', () => {
  const current = catalog(), raw = wire(current), retained = JSON.stringify(raw);
  const decoded = resolveFitProvenanceWire(raw, current);
  assert.equal(decoded.error, null);
  const canonical = normalizeFitAssessment(decoded.value, sources);
  assert.equal(canonical?.decision, raw.decision);
  assert.equal(canonical?.roleFitCheck?.currentIntent?.quote, sources['current-standing-instructions']);
  assert.equal(canonical?.roleFitCheck?.primaryOutputs?.[0].employerQuote, sources.employerText);
  assert.equal(roleFitProvenanceError(canonical?.roleFitCheck, sources), null);
  assert.equal(JSON.stringify(raw), retained, 'transport normalization never mutates its source or historical record');
  assert.equal(normalizeFitAssessment(canonical, sources)?.decision, 'apply', 'old canonical quote-shaped records remain accepted');
  assert.equal(resolveFitProvenanceWire(canonical, current).value, undefined, 'fresh wire replies cannot fall back to copied quotation fields');
  assert.equal(FIT_ASSESSMENT_VERSION, 'magnus-owned-fit-v27-current-preferences-required', 'new preference semantics invalidate prior reviews without deleting history');
});

test('wrong, foreign, stale and cross-source references fail closed without a semantic override', () => {
  for (const bad of ['p_invented', fitProvenanceCatalog(sources, [sources.employerText], 'other-owner/listing-one').employer[0].id!,
    fitProvenanceCatalog({ ...sources, employerText: sources.employerText + ' Changed.' }, [sources.employerText + ' Changed.'], 'owner-fixture/listing-one').employer[0].id!,
    catalog().preferences['current-target-role'][0].id!]) {
    const current = catalog(), raw = wire(current); raw.roleFitCheck.primaryOutputs[0].employerPassageId = bad;
    assert.ok(resolveFitProvenanceWire(raw, current).error, 'only this request’s exact employer passages can establish attribution');
  }
  const current = catalog(), wrongSource = wire(current);
  wrongSource.roleFitCheck.currentIntent.passageId = current.preferences['current-target-role'][0].id!;
  assert.match(resolveFitProvenanceWire(wrongSource, current).error ?? '', /selected current source/);
  const noSource = wire(current); noSource.roleFitCheck.currentIntent.source = 'none'; noSource.roleFitCheck.currentIntent.passageId = '';
  const resolved = resolveFitProvenanceWire(noSource, current);
  assert.equal(normalizeFitAssessment(resolved.value, sources), null, 'none remains invalid when a current preference source exists');
  const semanticError = wire(current); semanticError.roleFitCheck.primaryOutputs[0].output = 'A semantically unsupported output.';
  assert.equal(normalizeFitAssessment(resolveFitProvenanceWire(semanticError, current).value, sources)?.decision, 'apply', 'the adapter verifies identity, never adds a second semantic classifier');
});

test('all supplied Unicode/HTML evidence remains available once with bounded exact passage IDs', () => {
  const employerText = ('🦉雪 <b>Data & reporting</b> — preserve every qualifier. '.repeat(125)) + '\nEND-QUALIFIER';
  const currentSources = { ...sources, employerText }, current = fitProvenanceCatalog(currentSources, [employerText], 'unicode');
  assert.equal(current.employer.map(passage => passage.text).join(''), employerText);
  assert.ok(current.employer.length > 1);
  for (const passage of current.employer) {
    assert.ok([...passage.text].length <= 2000 && employerText.includes(passage.text));
    assert.doesNotMatch(passage.text, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u, 'a Unicode code point is never split');
  }
  const changed = fitProvenanceCatalog({ ...currentSources, employerText: employerText + ' changed' }, [employerText + ' changed'], 'unicode');
  assert.notEqual(current.employer[0].id, changed.employer[0].id, 'the full source digest invalidates even an unchanged leading passage');
  const schema = fitProvenanceWireSchema(current) as typeof current & Record<string, any>;
  assert.equal(schema.properties.currentIntent.additionalProperties, false);
  assert.equal(schema.properties.primaryOutputs.items.additionalProperties, false);
  const multiple = wire(current);
  multiple.roleFitCheck.primaryOutputs.push({ ...multiple.roleFitCheck.primaryOutputs[0], employerPassageId: current.employer.at(-1)!.id! });
  const decoded = normalizeFitAssessment(resolveFitProvenanceWire(multiple, current).value, currentSources);
  assert.equal(decoded?.roleFitCheck?.primaryOutputs?.[1].employerQuote, current.employer.at(-1)!.text, 'a second output receives its exact selected source instead of model-transcribed prose');
  multiple.roleFitCheck.primaryOutputs[1].employerPassageId = 'p_invalid_second_output';
  assert.equal(resolveFitProvenanceWire(multiple, current).value, undefined, 'an invalid later reference never returns a partial usable assessment');
});

test('empty duties remain uncertainty and extraction annotations never become citeable employer text', () => {
  const emptySources = { 'current-standing-instructions': '', 'current-target-role': '', 'current-search-preferences': '', employerText: '' };
  const empty = fitProvenanceCatalog(emptySources, [''], 'empty'), raw = wire();
  raw.decision = 'uncertain'; raw.roleFitCheck.alignment = 'uncertain'; raw.roleFitCheck.currentIntent = { scope: 'open', source: 'none', passageId: '', requestedWork: 'No current occupation boundary.' };
  raw.roleFitCheck.primaryOutputs = [];
  assert.equal(normalizeFitAssessment(resolveFitProvenanceWire(raw, empty).value, emptySources)?.decision, 'uncertain');
  assert.equal((fitProvenanceWireSchema(empty) as Record<string, any>).properties.primaryOutputs.maxItems, 0);
  const original = 'Data models. '.repeat(3000), spans = selectedEvidencePassages(original, 'data models', 2200);
  const rendered = relevantEvidence(original, 'data models', 2200);
  const extracted = fitProvenanceCatalog({ ...sources, employerText: rendered }, spans, 'retrieval');
  assert.ok(rendered.includes('[Selected verbatim passages;'));
  assert.ok(extracted.employer.every(p => original.includes(p.text)));
  assert.ok(extracted.employer.every(p => !p.text.includes('[Selected verbatim passages;') && !p.text.includes('[...]')));
  assert.equal(rendered, '[Selected verbatim passages; omitted text is not evidence of absence.]\n' + spans.join('\n[...]\n'), 'legacy extraction renderer remains byte compatible');
});
