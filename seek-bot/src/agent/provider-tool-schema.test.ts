import assert from 'node:assert/strict';
import test from 'node:test';
import { minimaxToolSchema, minimaxToolArguments } from './provider-tool-schema.js';
import { browserCommandContract } from './browser-command-schema.js';
import { browserTargetProperties } from './browser-target.js';
import { browserWaitProperties } from './native-browser.js';
import { validToolInput, toolInputIssue } from './tool-input.js';

const tool = { name: 'browser_action', description: 'Use the native browser', parameters: {
  type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['click', 'wait'] }, sends_application: { type: 'boolean' },
    ...browserTargetProperties, ...browserWaitProperties,
  }, required: ['action'], ...browserCommandContract(['click', 'wait'], true),
} };

test('JSON-text transport preserves nested waits while the original send and target validation stays mandatory', () => {
  const before = structuredClone(tool), wire = minimaxToolSchema(tool);
  assert.deepEqual(wire.parameters.required, ['arguments_json']);
  assert.match(wire.description, /sends_application/);
  const args = { action: 'click', ref: 'a1', sends_application: false,
    wait: { locator: { by: 'css', value: '#fixture' }, state: 'hidden', timeout_ms: 1000 } };
  assert.deepEqual(minimaxToolArguments(tool, { arguments_json: JSON.stringify(args) }), args);
  assert.equal(validToolInput(args, tool.parameters), true);
  for (const invalid of [{ action: 'click', ref: 'a1' }, { action: 'wait' },
    { action: 'wait', locator: { by: 'css', value: 'body' }, wait: { locator: {} } },
    { action: 'wait', locator: { by: 'css', value: 'body' }, unauthorized: true }]) {
    assert.equal(validToolInput(minimaxToolArguments(tool, { arguments_json: JSON.stringify(invalid) }), tool.parameters), false);
  }
  assert.deepEqual(tool, before);
});

test('malformed, extra and non-object wire arguments fail closed without echoing private input or repairing JSON', () => {
  for (const input of [{}, { arguments_json: '{"PRIVATE_ANSWER":42}}' }, { arguments_json: 'null' },
    { arguments_json: '[]' }, { arguments_json: '{}' , sends_application: true }, { arguments_json: {} }, null, [], 42]) {
    const decoded = minimaxToolArguments(tool, input as never);
    assert.equal(validToolInput(decoded, tool.parameters), false);
    assert.match(String(decoded.__parseError), /No tool operation ran/);
    assert.doesNotMatch(JSON.stringify(decoded), /PRIVATE_ANSWER/);
    const canonicalIssue = toolInputIssue(decoded, tool.parameters)!;
    assert.match(canonicalIssue, /complete arguments as one valid JSON object/);
    assert.doesNotMatch(canonicalIssue, /arguments_json|PRIVATE_ANSWER/, 'ordinary selected schemas never suggest an undeclared wrapper');
  }
});

test('JSON-decode guidance names only a wrapper declared by the selected schema', () => {
  const malformed = { __parseError: 'PRIVATE_JSON_INPUT must never be echoed' };
  const wrapper = minimaxToolSchema(tool).parameters;
  const issue = toolInputIssue(malformed, wrapper)!;
  assert.match(issue, /declared arguments_json field.*complete object as valid JSON text/);
  assert.match(issue, /No tool operation ran/);
  assert.doesNotMatch(issue, /PRIVATE_JSON_INPUT/);
  for (const schema of [tool.parameters, { type: 'object', properties: { nested: { type: 'object', properties: { arguments_json: { type: 'string' } } } } },
    { type: 'object', properties: { arguments_json: { type: 'number' } } }]) {
    assert.doesNotMatch(toolInputIssue(malformed, schema)!, /arguments_json/, 'unoffered, nested or differently typed fields do not advertise a JSON-text wrapper');
    assert.equal(validToolInput(malformed, schema), false, 'feedback never makes malformed input executable');
  }
  assert.equal(validToolInput({ arguments_json: '{}' }, tool.parameters), false, 'undeclared wrapper input remains rejected by the original strict contract');
});

test('simple value unions and the already serialized helper contract retain their existing wire format', () => {
  const simple = { name: 'simple', description: 'Fixture', parameters: { type: 'object', additionalProperties: false,
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] }, definition_json: { type: 'string' } },
    required: ['definition_json'] } };
  assert.equal(minimaxToolSchema(simple), simple);
  const args = { definition_json: '{"steps":[]}' };
  assert.equal(minimaxToolArguments(simple, args), args);
  const batch = { ...simple, parameters: { type: 'object', properties: { actions: { type: 'array', items: tool.parameters } } } };
  assert.deepEqual(minimaxToolSchema(batch).parameters.required, ['arguments_json']);
});
