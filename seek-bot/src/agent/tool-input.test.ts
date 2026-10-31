import assert from 'node:assert/strict';
import test from 'node:test';
import { validToolInput, toolInputIssue } from './tool-input.js';

test('tool dispatch rejects missing, unknown and malformed nested arguments', () => {
  const schema = { type: 'object', properties: {
    action: { type: 'object', properties: { ref: { type: 'string', minLength: 1 } }, required: ['ref'] },
  }, required: ['action'] };
  assert.equal(validToolInput({ action: { ref: 'a1' } }, schema), true);
  for (const input of [{}, { action: null }, { action: { ref: '' } }, { action: { ref: 'a1', secret: true } }, { action: { ref: 1 } }]) {
    assert.equal(validToolInput(input, schema), false);
  }
});

test('nested contract diagnostics locate the error without repeating supplied private values', () => {
  const schema = { type: 'object', properties: { actions: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: {
    action: { type: 'string', enum: ['fill', 'click'] }, value: { type: 'string' },
  }, required: ['action'] } } }, required: ['actions'] };
  assert.equal(toolInputIssue({ actions: [{ action: 'fill', value: 'PRIVATE_CANDIDATE_FACT' }] }, schema), null);
  const issue = toolInputIssue({ actions: [{ action: 'SECRET_INCORRECT_ENUM', value: 'PRIVATE_CANDIDATE_FACT' }] }, schema)!;
  assert.match(issue, /\$\.actions\[0\]\.action/);
  assert.match(issue, /fill.*click/);
  assert.doesNotMatch(issue, /SECRET_|PRIVATE_/);
  assert.match(toolInputIssue({ actions: [{}] }, schema)!, /\$\.actions\[0\]\.action is required/);
  const unknown = toolInputIssue({ actions: [{ action: 'fill', value: 'PRIVATE_CANDIDATE_FACT', timeout_ms: 1000 }] }, schema)!;
  assert.match(unknown, /\$\.actions\[0\].*undeclared properties: "timeout_ms"/);
  assert.match(unknown, /This tool call did not run/);
  assert.doesNotMatch(unknown, /PRIVATE_CANDIDATE_FACT|1000/);
});

test('bounded batches and declared options are checked before any browser action', () => {
  const schema = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['observe', 'click'] } };
  assert.equal(validToolInput(['observe', 'click'], schema), true);
  for (const input of [[], ['invented'], ['observe', 'observe', 'click'], 'click']) {
    assert.equal(validToolInput(input, schema), false);
  }
  assert.equal(validToolInput(0.3, { type: 'number', multipleOf: 0.1, minimum: 0, exclusiveMaximum: 1 }), true);
  assert.equal(validToolInput(Infinity, { type: 'number' }), false);
  assert.equal(validToolInput(1, { type: 'number', exclusiveMaximum: 1 }), false);
});

test('alternative required inputs share the closed parent schema and diagnose missing alternatives', () => {
  const schema = { type: 'object', properties: { purpose: { type: 'string' }, ref: { type: 'string', minLength: 1 },
    refs: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['purpose'],
    anyOf: [{ required: ['ref'] }, { required: ['refs'] }] };
  assert.equal(validToolInput({ purpose: 'sign_in' }, schema), false);
  assert.equal(validToolInput({ purpose: 'sign_in', ref: 'f0' }, schema), true);
  assert.equal(validToolInput({ purpose: 'sign_in', refs: ['f0'] }, schema), true);
  assert.equal(validToolInput({ purpose: 'sign_in', ref: 'f0', refs: ['f0'] }, schema), true, 'anyOf permits more than one valid alternative');
  assert.equal(validToolInput({ purpose: 'sign_in', ref: 'f0', undeclared: 'PRIVATE' }, schema), false);
  assert.match(toolInputIssue({ purpose: 'PRIVATE' }, schema)!, /\$\.ref or \$\.refs/);
  assert.doesNotMatch(toolInputIssue({ purpose: 'PRIVATE' }, schema)!, /PRIVATE/);
  assert.match(toolInputIssue({ purpose: 'sign_in', refs: [] }, schema)!, /\$\.refs must contain/);
});
