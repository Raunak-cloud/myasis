import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { getPool } from './db/index.js';
import { gmailAccess, gmailProviderPolicy, selectGmailProvider } from './gmail-access.js';
const pool = getPool();
after(async () => { await pool.end(); });
test('pending verification forces normal users to browser while admins can choose either; public release is explicit', async () => {
  assert.deepEqual(gmailProviderPolicy(false, false, 'mcp'), { provider: 'browser', providers: ['browser'] });
  assert.deepEqual(gmailProviderPolicy(true, false, 'mcp'), { provider: 'mcp', providers: ['browser', 'mcp'] });
  assert.deepEqual(gmailProviderPolicy(true, false, 'browser'), { provider: 'browser', providers: ['browser', 'mcp'] });
  assert.deepEqual(gmailProviderPolicy(false, true, 'browser'), { provider: 'mcp', providers: ['mcp'] });
  const original = pool.query, before = process.env.GMAIL_MCP_PUBLIC_ENABLED;
  process.env.GMAIL_MCP_PUBLIC_ENABLED = 'false';
  let readTokens = false;
  pool.query = (async (sql: string) => {
    if (sql.startsWith('SELECT u.email,p.email')) return { rows: [{ email: 'unprivileged@fixture.invalid', profile_email: 'unprivileged@fixture.invalid' }] };
    if (sql.startsWith('SELECT key,value')) return { rows: [{ key: 'GMAIL_PROVIDER', value: 'mcp' }] };
    if (sql.includes('google_connections')) readTokens = true;
    throw new Error('Unexpected mailbox access');
  }) as typeof original;
  try {
    const access = await gmailAccess('gmail-policy-fixture');
    assert.equal(access.provider, 'browser'); assert.equal(access.connected, false); assert.equal(readTokens, false);
    await assert.rejects(selectGmailProvider('gmail-policy-fixture', 'mcp'), /not available/);
    assert.equal(readTokens, false, 'existing OAuth tokens cannot bypass the pending-verification policy');
  } finally { pool.query = original; if (before === undefined) delete process.env.GMAIL_MCP_PUBLIC_ENABLED; else process.env.GMAIL_MCP_PUBLIC_ENABLED = before; }
});
