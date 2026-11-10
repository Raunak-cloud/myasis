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

test('ordinary typed arguments preserve nested waits and frame targets without changing dispatch validation', () => {
  const before = structuredClone(tool), wire = minimaxToolSchema(tool);
  assert.deepEqual(wire.parameters.required, ['action']);
  assert.equal(wire.parameters.anyOf, undefined);
  assert.equal(wire.description, tool.description);
  assert.ok((wire.parameters.properties as Record<string,unknown>).locator);
  assert.equal((wire.parameters.properties as Record<string,unknown>).arguments_json, undefined);
  const args = { action: 'click', locator: { by: 'css', value: '#apply', frame: 'frame1' }, sends_application: false,
    wait: { locator: { by: 'css', value: '#fixture' }, state: 'hidden', timeout_ms: 1000 } };
  assert.deepEqual(minimaxToolArguments(tool, JSON.parse(JSON.stringify(args))), args);
  assert.equal(validToolInput(args, tool.parameters), true);
  for (const invalid of [{ action: 'click', ref: 'a1' }, { action: 'wait' },
    { action: 'wait', locator: { by: 'css', value: 'body' }, wait: { locator: {} } },
    { action: 'wait', locator: { by: 'css', value: 'body' }, unauthorized: true }, { arguments_json: JSON.stringify(args) }]) {
    assert.equal(validToolInput(minimaxToolArguments(tool, invalid), tool.parameters), false);
  }
  assert.deepEqual(tool, before);
});

test('batch projection preserves nested typed arrays while canonical rules reject unsafe incomplete commands', () => {
  const batch={name:'browser_batch',description:'Run commands',parameters:{type:'object',additionalProperties:false,
    properties:{actions:{type:'array',items:tool.parameters}},required:['actions']}};
  const wire=minimaxToolSchema(batch);
  const items=((wire.parameters.properties as any).actions.items);
  assert.equal(items.anyOf,undefined);assert.ok(items.properties.locator.properties.frame);
  const args={actions:[{action:'click',selector:'#continue',sends_application:false},
    {action:'wait',wait:{url:'https://fixture.invalid/next'}}]};
  assert.deepEqual(minimaxToolArguments(batch,args),args);
  assert.equal(validToolInput(args,batch.parameters),true);
  assert.equal(validToolInput({actions:[{action:'click',selector:'#send'}]},batch.parameters),false);
});

test('malformed input remains non-executable and private parse content is not echoed', () => {
  const malformed={__parseError:'PRIVATE_JSON_INPUT'};
  const decoded=minimaxToolArguments(tool,malformed);
  assert.equal(validToolInput(decoded,tool.parameters),false);
  const issue=toolInputIssue(decoded,tool.parameters)!;
  assert.match(issue,/complete arguments as one valid JSON object/);
  assert.doesNotMatch(issue,/PRIVATE_JSON_INPUT|arguments_json/);
});

test('scalar unions and helper recipe strings remain typed without an added transport wrapper', () => {
  const simple={name:'helper',description:'Fixture',parameters:{type:'object',additionalProperties:false,
    properties:{value:{anyOf:[{type:'string'},{type:'number'}]},definition_json:{type:'string'}},required:['definition_json']}};
  assert.deepEqual(minimaxToolSchema(simple),simple);
  const args={definition_json:'{"steps":[]}'};
  assert.equal(minimaxToolArguments(simple,args),args);
});
