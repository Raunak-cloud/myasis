import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeInstructionVerdict, validateInstructionVerdict } from './instruction-policy.js';

const rules = 'Avoid manager roles. Exception: junior or associate product manager roles are allowed.';
const check = (status: string, conditionStatus: string) => ({checks:[{
  ruleQuote:'Avoid manager roles.',status,reason:'The posting describes the level.',
  exceptionQuote:'junior or associate product manager roles are allowed',
  exceptionConditions:[{conditionQuote:'junior or associate',jobEvidence:'The role level in the posting.',status:conditionStatus}],
}],injectionSuspected:false});

test('a contradicted exception cannot authorize an otherwise excluded role', () => {
  assert.equal(normalizeInstructionVerdict(check('satisfied','not-met'),rules)?.decision,'skip');
});
test('an unproved exception withholds rather than expands permission', () => {
  assert.equal(normalizeInstructionVerdict(check('satisfied','unclear'),rules)?.decision,'uncertain');
});
test('the model can establish an OR exception without requiring both alternatives', () => {
  assert.equal(normalizeInstructionVerdict(check('satisfied','met'),rules)?.decision,'allow');
});
test('one violated instruction takes precedence over other satisfied instructions', () => {
  const raw=check('violated','not-met');
  raw.checks.push({...raw.checks[0],status:'satisfied',exceptionConditions:[{...raw.checks[0].exceptionConditions[0],status:'met'}]});
  assert.equal(normalizeInstructionVerdict(raw,rules)?.decision,'skip');
});
test('invented rule and exception conditions are rejected', () => {
  const raw=check('satisfied','met');raw.checks[0].exceptionConditions[0].conditionQuote='any product manager';
  assert.equal(normalizeInstructionVerdict(raw,rules),null);
});
test('the old empty-conflict reply and empty exception proof fail closed', () => {
  assert.equal(normalizeInstructionVerdict({conflict:'',because:'Allowed'},rules),null);
  const raw=check('satisfied','met');raw.checks[0].exceptionConditions=[];
  assert.equal(normalizeInstructionVerdict(raw,rules),null);
});
test('suspected injection never authorizes an application', () => {
  const raw=check('satisfied','met');raw.injectionSuspected=true;
  const verdict=normalizeInstructionVerdict(raw,rules);
  assert.equal(verdict?.decision,'uncertain');
  assert.equal(verdict?.injectionSuspected,true);
  assert.deepEqual(verdict?.injectionSources,['instruction-check']);
  assert.deepEqual(validateInstructionVerdict(raw,rules,'exception-review').verdict?.injectionSources,['exception-review']);
});
test('typographic quotes do not turn a valid rule citation into an unavailable review', () => {
  const raw={checks:[{ruleQuote:"Only APM Group's roles",status:'satisfied',reason:'Named employer matches.',exceptionQuote:'',exceptionConditions:[]}],injectionSuspected:false};
  assert.equal(normalizeInstructionVerdict(raw,'Only APM Group’s roles')?.decision,'allow');
});

test('invalid evidence identifies the field to correct without accepting invented quotes', () => {
  const raw = check('satisfied', 'met');
  raw.checks[0].exceptionConditions[0].conditionQuote = 'any product manager';
  const validation = validateInstructionVerdict(raw, rules);
  assert.equal(validation.verdict, null);
  assert.match(validation.error!, /checks\[0\]\.exceptionConditions\[0\]\.conditionQuote/);
  assert.match(validation.error!, /verbatim part of exceptionQuote/);
});

test('missing evidence and inconsistent exception structures have actionable diagnostics', () => {
  const raw = check('satisfied', 'unclear');
  raw.checks[0].exceptionConditions[0].jobEvidence = '';
  assert.match(validateInstructionVerdict(raw, rules).error!, /jobEvidence.*what is missing when unclear/);
  raw.checks[0].exceptionQuote = '';
  assert.match(validateInstructionVerdict(raw, rules).error!, /must be empty when exceptionQuote is empty/);
});
