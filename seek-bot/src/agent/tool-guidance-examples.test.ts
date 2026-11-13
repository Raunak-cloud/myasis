import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOnlyTools } from './agent-only.js';
import { authenticationTools, EMAILED_CODE_EXAMPLES } from './auth-tools.js';
import { BROWSER_ACTION_EXAMPLES } from './ordinary-field-guidance.js';
import { minimaxToolSchema, minimaxToolArguments } from './provider-tool-schema.js';
import { validToolInput, toolInputIssue } from './tool-input.js';

test('all advertised browser examples are executable contracts for both providers and applicable batches', () => {
  const browser = agentOnlyTools.find(tool => tool.name === 'browser_action')!;
  const batch = agentOnlyTools.find(tool => tool.name === 'browser_batch')!;
  const batchItems = ((batch.parameters.properties as Record<string, Record<string, unknown>>).actions.items as Record<string, unknown>);
  const batchActions = ((batchItems.properties as Record<string, Record<string, unknown>>).action.enum as string[]);
  for (const example of BROWSER_ACTION_EXAMPLES) {
    assert.ok(browser.description.includes(JSON.stringify(example)), 'The tested example must be the one the model sees');
    assert.equal(validToolInput(example, browser.parameters), true, toolInputIssue(example, browser.parameters) ?? '');
    assert.equal(validToolInput(example, minimaxToolSchema(browser).parameters), true);
    assert.deepEqual(minimaxToolArguments(browser, structuredClone(example)), example, 'Examples need no argument coercion');
    if (batchActions.includes(example.action)) assert.equal(validToolInput({ actions: [example] }, batch.parameters), true);
  }
  for (const incomplete of [
    { action: 'set_input_files', ref: 'f0', file_id: 'document' },
    { action: 'set_input_files', ref: 'f0', value: 'Sydney' },
    { action: 'script' }, { action: 'wait' },
  ]) assert.equal(validToolInput(incomplete, browser.parameters), false, 'Descriptions do not rewrite incomplete tool calls');
});

test('both emailed-code examples include the targets required even on the message-selection call', () => {
  const names = ['GMAIL_MCP_URL', 'GMAIL_MCP_TOKEN', 'GMAIL_MCP_ACCOUNT'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { GMAIL_MCP_URL: 'https://mail.fixture.invalid', GMAIL_MCP_TOKEN: 'fixture-only', GMAIL_MCP_ACCOUNT: 'candidate@fixture.invalid' });
  try {
    const tool = authenticationTools().find(tool => tool.name === 'enter_emailed_code')!;
    for (const example of EMAILED_CODE_EXAMPLES) {
      assert.ok(tool.description.includes(JSON.stringify(example)));
      assert.equal(validToolInput(example, tool.parameters), true);
      assert.equal(validToolInput(example, minimaxToolSchema(tool).parameters), true);
    }
    assert.equal('credential_id' in EMAILED_CODE_EXAMPLES[0], false);
    assert.ok(EMAILED_CODE_EXAMPLES[1].credential_id);
    assert.equal(validToolInput({ purpose: 'account_verification' }, tool.parameters), false, 'Missing targets retain their existing behavior');
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
