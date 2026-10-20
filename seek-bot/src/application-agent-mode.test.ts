import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentOnlyApplication } from './application-agent-mode.js';
import { withApplicationModel } from './application-model.js';

test('agent-only requires both the explicit selection and runner authorization', () => {
  for (const env of [{}, { APPLICATION_AGENT_MODE: 'agent-only' },
    { APPLICATION_AGENT_MODE_AUTHORIZED: 'true' },
    { APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'false' },
    { APPLICATION_AGENT_MODE: 'protected', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }]) {
    assert.equal(isAgentOnlyApplication(env), false);
  }
  assert.equal(isAgentOnlyApplication({ APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true' }), true);
});

test('account-scoped mode does not leak between concurrent requests or change execution limits', async () => {
  const agent = { APPLICATION_AGENT_MODE: 'agent-only', APPLICATION_AGENT_MODE_AUTHORIZED: 'true', DRY_RUN: 'true', EXTERNAL_APPLY_ENABLED: 'false' };
  const protectedMode = { APPLICATION_AGENT_MODE: 'protected', APPLICATION_AGENT_MODE_AUTHORIZED: 'false' };
  const results = await Promise.all([agent, protectedMode].map(env => withApplicationModel(env, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return isAgentOnlyApplication();
  })));
  assert.deepEqual(results, [true, false]);
  assert.equal(agent.DRY_RUN, 'true');
  assert.equal(agent.EXTERNAL_APPLY_ENABLED, 'false');
});
