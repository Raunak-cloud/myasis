import assert from 'node:assert/strict';
import test from 'node:test';
import { validToolInput, toolInputIssue } from './tool-input.js';
import { browserCommandContract } from './browser-command-schema.js';
import { browserTargetProperties,hasBrowserTarget } from './browser-target.js';

test('explicit open payloads stay open while ordinary tool contracts stay closed and null stays typed',()=>{
 assert.equal(validToolInput({definition:{arbitrary:'data'}},{type:'object',properties:{definition:{type:'object',additionalProperties:true}}}),true);
 assert.equal(validToolInput({arbitrary:'data'},{type:'object'}),false);
 assert.equal(validToolInput(null,{type:'null'}),true);
 assert.equal(validToolInput('not null',{type:'null'}),false);
});

test('confirmation-mode send intent is enforced by the same advertised command schema before any batch work',()=>{
 const command={type:'object',properties:{action:{type:'string'},sends_application:{type:'boolean'}},...browserCommandContract(['fill','click','press'],true)};
 for(const action of ['click','press']){
  assert.equal(validToolInput({action},command),false);
  assert.match(toolInputIssue({action},command)!,/sends_application is required/);
  for(const sends_application of [true,false])assert.equal(validToolInput({action,sends_application},command),true);
 }
 assert.equal(validToolInput({action:'fill'},command),true);
 assert.equal(validToolInput([{action:'fill'},{action:'click'}],{type:'array',items:command}),false,'partial batches are rejected before the first fill');
});

test('frame-only and invented references are rejected before browser dispatch',()=>{
  for(const ref of ['a0','f3','f1:2','e12','f1e12','frame1:f2','frame1:a3:2'])assert.equal(validToolInput(ref,browserTargetProperties.ref),true,ref);
  for(const ref of ['frame1','SECRET_INVALID_REF','a0\n','frame1:frame2']){
    assert.equal(validToolInput(ref,browserTargetProperties.ref),false);
    assert.doesNotMatch(toolInputIssue(ref,browserTargetProperties.ref)!,/SECRET_INVALID_REF/);
  }
  assert.match(toolInputIssue('frame1',browserTargetProperties.ref)!,/control reference.*locator/);
  assert.equal(validToolInput('',browserTargetProperties.ref),true,'empty optional ref denotes no selected target');
  assert.equal(hasBrowserTarget({ref:''}),false,'an empty reference cannot resolve a writable control');
});

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

test('action-specific browser contracts require executable script, files and wait conditions', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['script', 'set_input_files', 'wait', 'click'] },
    ...browserTargetProperties,
    script: { type: 'string' }, file_ids: { type: 'array', items: { type: 'string' } },
    timeout_ms: { type: 'number' }, wait: { type: 'object', properties: { url: { type: 'string' }, timeout_ms: { type: 'number' }, ref: { type: 'string' } } },
  }, required: ['action'], ...browserCommandContract(['script', 'set_input_files', 'wait', 'click']) };
  for (const args of [
    { action: 'script', script: 'return document.title' },
    { action: 'set_input_files', ref: 'f0', file_ids: ['5'] },
    { action: 'set_input_files', ref: 'f0', file_ids: [] },
    { action: 'set_input_files', target_mode:'locator',locator:{by:'css',value:'input[type=file]'},file_ids:['5'] },
    { action: 'set_input_files', locator:{by:'css',value:'input[type=file]'},file_ids:['5'] },
    { action: 'wait', ref: 'f0', timeout_ms: 1000 },
    { action: 'wait', wait: { url: '**/receipt', timeout_ms: 1000 } },
    { action: 'click', ref: 'a0' },
    { action: 'click', ref: 'a0',script:'' },
  ]) assert.equal(validToolInput(args, schema), true, JSON.stringify(args));
  assert.match(toolInputIssue({ action: 'script' }, schema)!, /\$\.script is required/);
  assert.match(toolInputIssue({ action: 'set_input_files', ref: 'f0' }, schema)!, /\$\.file_ids is required/);
  for (const args of [
    { action: 'script', script: '' },
    { action: 'set_input_files', file_ids: ['5'] },
    { action: 'set_input_files',file_ids:['5'],ref:'' },
    { action: 'set_input_files',target_mode:'ref',file_ids:['5'],ref:'',selector:'input' },
    { action: 'set_input_files',target_mode:'locator',file_ids:['5'],locator:{by:'css',value:''} },
    { action: 'wait', timeout_ms: 1000 },
    { action: 'wait', wait: { timeout_ms: 1000 } },
    { action: 'wait',ref:'' },
    { action: 'wait',wait:{url:''} },
  ]) assert.equal(validToolInput(args, schema), false, JSON.stringify(args));
  const batch = { type: 'array', items: schema };
  assert.match(toolInputIssue([{ action: 'click', ref: 'a0' }, { action: 'set_input_files', ref: 'f0' }], batch)!, /\$\[1\]\.file_ids is required/);
});

test('the failing upload calls explain plural document IDs and ordinary typing without rewriting arguments', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['fill', 'select', 'set_input_files'] },
    ...browserTargetProperties, value: { type: 'string' }, file_ids: { type: 'array', items: { type: 'string' } },
  }, required: ['action'], ...browserCommandContract(['fill', 'select', 'set_input_files']) };
  const wrong = { action: 'set_input_files', ref: 'f0', value: 'PRIVATE_CANDIDATE_CITY' };
  const original = structuredClone(wrong);
  const issue = toolInputIssue(wrong, schema)!;
  assert.match(issue, /file_ids is required.*array of document IDs.*action="fill" with value/);
  assert.doesNotMatch(issue, /PRIVATE_CANDIDATE_CITY/);
  assert.deepEqual(wrong, original);
  assert.equal(validToolInput(wrong, schema), false);
  assert.match(toolInputIssue({ action: 'set_input_files', ref: 'f0', file_id: 'PRIVATE_DOCUMENT' }, schema)!, /file_id is not an upload argument.*file_ids \(plural\)/);
  assert.equal(validToolInput({ action: 'fill', ref: 'f0', value: 'Sydney' }, schema), true);
  assert.equal(validToolInput({ action: 'set_input_files', ref: 'f0', file_ids: ['cv'] }, schema), true);
});
