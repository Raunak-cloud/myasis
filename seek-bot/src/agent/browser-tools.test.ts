import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentOnlyTools } from './agent-only.js';
import { browserToolCall, namedBrowserToolCall, splitBrowserTools } from './browser-tools.js';
import { minimaxToolSchema } from './provider-tool-schema.js';
import { toolInputIssue } from './tool-input.js';
import { traceProvesNoSend } from '../repair-safety.js';

test('dedicated browser tools require only their own arguments for both providers', () => {
  const cases = [
    ['browser_fill', { ref: 'f0', value: 'Alex' }, { ref: 'f0' }],
    ['browser_upload', { ref: 'f1', file_ids: ['cv'] }, { ref: 'f1' }],
    ['browser_click', { ref: 'a1' }, {}],
    ['browser_navigate', { url: 'https://fixture.invalid/apply' }, {}],
  ] as const;
  for (const [name, valid, invalid] of cases) {
    const tool = agentOnlyTools.find(tool => tool.name === name)!;
    for (const schema of [tool.parameters, minimaxToolSchema(tool).parameters]) {
      assert.equal(toolInputIssue(valid, schema), null, name);
      assert.ok(toolInputIssue(invalid, schema), name);
      assert.ok(toolInputIssue({ ...valid, action: 'fill' }, schema), 'No action discriminator is needed or advertised');
    }
  }
  const generic = agentOnlyTools.find(tool => tool.name === 'browser_action')!;
  const props = generic.parameters.properties as Record<string, any>;
  for (const action of ['click', 'fill', 'set_input_files', 'navigate']) assert.ok(!props.action.enum.includes(action));
  assert.equal(props.file_ids, undefined);
  assert.ok(props.action.enum.includes('take_snapshot'));
  assert.ok(props.action.enum.includes('script'));
  assert.equal(new Set(agentOnlyTools.map(tool => tool.name)).size, agentOnlyTools.length);
});

test('named operations preserve native arguments, upload IDs, frames and send intent', () => {
  for (const command of [
    { action: 'fill', ref: 'f1', value: 'Exact value' },
    { action: 'click', locator: { by: 'role', value: 'button', name: 'Submit', frame: 'frame1' }, sends_application: true },
    { action: 'set_input_files', selector: 'input[type=file]', file_ids: ['cv'], replaces_file_ids: ['old'], file_chooser: false },
    { action: 'navigate', value: 'https://fixture.invalid/apply', wait: { url: '**/apply' } },
  ]) {
    const before = structuredClone(command), named = namedBrowserToolCall('browser_action', command);
    assert.deepEqual(browserToolCall(named.name, named.args), { name: 'browser_action', args: command });
    assert.deepEqual(command, before);
  }
});

test('semi-auto click retains required send intent and excludes coordinate clicks', () => {
  const legacy = { name: 'browser_action', description: '', parameters: { type: 'object', additionalProperties: false,
    properties: { action: { enum: ['click', 'fill', 'navigate', 'set_input_files', 'inspect'] },
      ref: { type: 'string' }, selector: { type: 'string' }, locator: { type: 'object' }, target_mode: { enum: ['ref'] },
      value: { type: 'string' }, file_ids: { type: 'array' }, wait: { type: 'object' }, sends_application: { type: 'boolean' } }, required: ['action'] } };
  const click = splitBrowserTools(legacy, true).find(tool => tool.name === 'browser_click')!;
  assert.ok(toolInputIssue({ ref: 'a1' }, click.parameters));
  assert.equal(toolInputIssue({ ref: 'a1', sends_application: false }, click.parameters), null);
  assert.equal(toolInputIssue({ ref: 'a1', sends_application: true }, click.parameters), null);
  assert.ok(toolInputIssue({ x: 10, y: 20, sends_application: true }, click.parameters));
});

test('recovery audits still recognize sends, uncertain clicks and changed destinations under the new names', () => {
  const trace = { runStartId: '1', attemptId: 'fixture', outcome: { status: 'skipped' }, sendAudit: { attempted: false },
    job: { url: 'https://fixture.invalid/apply' } };
  const check = (tool: string, args: Record<string, unknown>) => traceProvesNoSend({ ...trace,
    steps: [{ tool, args, execution: 'started', completedAt: new Date().toISOString() }] }, '1', 'fixture');
  for (const tool of ['browser_fill', 'browser_upload', 'browser_click']) {
    assert.equal(check(tool, { ref: 'f0', sends_application: false }), true);
    assert.equal(check(tool, { ref: 'f0', sends_application: true }), false);
  }
  assert.equal(check('browser_click', { ref: 'a1' }), false);
  assert.equal(check('browser_navigate', { url: trace.job.url }), true);
  assert.equal(check('browser_navigate', { url: 'https://fixture.invalid/other' }), false);
  assert.deepEqual(browserToolCall('constructor', { value: 'unchanged' }), { name: 'constructor', args: { value: 'unchanged' } });
});
