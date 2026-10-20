import assert from 'node:assert/strict';
import test from 'node:test';
import { validToolInput } from './tool-input.js';

test('tool dispatch rejects missing, unknown and malformed nested arguments', () => {
  const schema = { type: 'object', properties: {
    action: { type: 'object', properties: { ref: { type: 'string', minLength: 1 } }, required: ['ref'] },
  }, required: ['action'] };
  assert.equal(validToolInput({ action: { ref: 'a1' } }, schema), true);
  for (const input of [{}, { action: null }, { action: { ref: '' } }, { action: { ref: 'a1', secret: true } }, { action: { ref: 1 } }]) {
    assert.equal(validToolInput(input, schema), false);
  }
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
