import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticationTools } from './auth-tools.js';
import { doCompleteAuthentication, doEnterEmailedCode, doOpenEmailedLink } from './authentication.js';
import { GmailMcpService } from '../gmail-mcp-service.js';
import { failedToolResult, ok, type ToolContext } from './context.js';
import { toolInputIssue, validToolInput } from './tool-input.js';

test('the live missing-target replay is rejected before a mailbox read or browser action', async () => {
  const names = ['GMAIL_MCP_URL', 'GMAIL_MCP_TOKEN', 'GMAIL_MCP_ACCOUNT'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { GMAIL_MCP_URL: 'https://mailbox.fixture.invalid', GMAIL_MCP_TOKEN: 'fixture-only', GMAIL_MCP_ACCOUNT: 'candidate@fixture.invalid' });
  const noAccess = new Proxy({}, { get: () => { throw Error('Missing arguments must not touch a browser or mailbox'); } });
  const ctx = { page: noAccess, profile: { email: 'candidate@fixture.invalid' }, observation: { fields: [{ ref: 'f0', label: 'Verification code' }] } } as unknown as ToolContext;
  try {
    const tools = authenticationTools();
    const codeSchema = tools.find(tool => tool.name === 'enter_emailed_code')!.parameters;
    const credentialSchema = tools.find(tool => tool.name === 'complete_authentication')!.parameters;
    const missing = { purpose: 'sign_in', sender_hint: 'PRIVATE_CANDIDATE_FACT' };
    assert.equal(validToolInput(missing, codeSchema), false);
    const issue = toolInputIssue(missing, codeSchema)!;
    assert.match(issue, /\$\.targets.*\$\.ref.*\$\.refs/);
    assert.doesNotMatch(issue, /PRIVATE_CANDIDATE_FACT/);
    for (const target of [{ ref: 'f0' }, { refs: ['f0', 'frame1:f1'] }, { targets: [{ selector: '#code' }] },
      { targets: [{ locator: { by: 'label', value: 'Verification code digit 1' } }] }]) {
      assert.equal(validToolInput({ purpose: 'sign_in', ...target }, codeSchema), true);
    }
    for (const target of [{ ref: '' }, { refs: [] }, { refs: [''] }, { targets: [] }, { targets: [{}] }, { targets: [{ selector: '' }] }]) {
      assert.equal(validToolInput({ purpose: 'sign_in', ...target }, codeSchema), false);
    }
    assert.equal(validToolInput({ purpose: 'sign_in', reason: 'Observed login' }, credentialSchema), false);
    assert.equal(validToolInput({ purpose: 'sign_in', reason: 'Observed login', refs: ['f0'] }, credentialSchema), true);
    for (const input of [missing, { purpose: 'sign_in', refs: [] }, { purpose: 'sign_in', refs: ['unknown'] }, { purpose: 'sign_in', refs: ['f0', 'f0'] }]) {
      const result = await doEnterEmailedCode(ctx, input);
      assert.equal(result.kind === 'ok' && result.disposition, 'invalid-arguments');
      assert.equal(failedToolResult(result), true);
    }
    const credentials = await doCompleteAuthentication(ctx, { purpose: 'sign_in' });
    assert.equal(credentials.kind === 'ok' && credentials.disposition, 'invalid-arguments');
    assert.equal(failedToolResult(credentials), true);
    const linkSchema = tools.find(tool => tool.name === 'open_emailed_link')!.parameters;
    assert.equal(validToolInput({ purpose: 'account_verification' }, linkSchema), true, 'an emailed link needs no input target');
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});

test('rejected arguments cannot count as successful work; expected handoffs still can reobserve', () => {
  assert.equal(failedToolResult(ok('Missing target', 'invalid-arguments')), true);
  assert.equal(failedToolResult(ok('Browser failed', 'failed')), true);
  assert.equal(failedToolResult(ok('Current page changed', 'reobserve')), false);
  assert.equal(failedToolResult(ok('Filled', 'completed')), false);
  assert.equal(failedToolResult({ kind: 'terminal', outcome: { status: 'applied' } }), false);
});

test('emailed reset keeps the observed employer tenant after SuccessFactors drops company from the page URL', async () => {
  const names = ['GMAIL_MCP_URL', 'GMAIL_MCP_TOKEN', 'GMAIL_MCP_ACCOUNT', 'GMAIL_ACCESS_MODE'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const destination = 'https://career10.successfactors.com/career?company=fixtureTenant&login_ns=pwd_reset&verify=fixture-token';
  const queries: string[] = [], navigated: string[] = [];
  const gateway = new GmailMcpService({
    search: async (_owner, query) => { queries.push(query); return [{ id: 'fixture-thread' }]; },
    thread: async () => [{ id: 'fixture-message', sender: 'system@successfactors.com', subject: 'Password Reset', date: new Date().toISOString(),
      plaintextBody: 'Please click on the URL below to change your password.', htmlBody: `<a href="${destination}">Click Here</a>` }],
    send: async () => { throw Error('Authentication must not send email'); },
  });
  const lease = await gateway.grant('fixture-owner', 'candidate@fixture.invalid');
  Object.assign(process.env, { GMAIL_MCP_URL: lease.connection.url, GMAIL_MCP_TOKEN: lease.connection.token,
    GMAIL_MCP_ACCOUNT: lease.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
  const original = { url: () => 'https://career10.successfactors.com/career?_s.crb=PRIVATE_SESSION',
    context: () => ({ newPage: async () => ({ goto: async (url: string) => { navigated.push(url); } }) }) };
  const ctx = { page: original, authenticationRealm: 'https://career10.successfactors.com/?company=fixtureTenant',
    job: { company: 'Fixture Employer', url: 'https://www.seek.com.au/job/12345678' }, profile: { email: 'candidate@fixture.invalid' },
    actions: [], log: () => {} } as unknown as ToolContext;
  try {
    const result = await doOpenEmailedLink(ctx, { purpose: 'reset_password', sender_hint: 'SuccessFactors' });
    assert.match(result.kind === 'ok' ? result.message : '', /Opened the emailed link/);
    assert.deepEqual(navigated, [destination]);
    assert.match(queries[0], /fixturetenant/);
    assert.doesNotMatch(queries.join(' '), /PRIVATE_SESSION/);
  } finally {
    lease.revoke(); await gateway.close();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
