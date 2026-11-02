import { gmailConnection, gmailRequest } from './gmail-connection.js';
import { sendApprovedApplicationEmail } from './application-email.js';
import { GmailMcpService } from '../../seek-bot/src/gmail-mcp-service.js';
import { GmailMcpClient } from '../../seek-bot/src/gmail-mcp-client.js';
import { gmailApiReader } from './gmail-api-reader.js';
import { gmailAccess } from './gmail-access.js';
import { registerGmailBrowser, searchBrowserGmail, readBrowserGmail } from '../../seek-bot/src/gmail-browser.js';

const apiReader = gmailApiReader(gmailRequest);
const gmailMcp = new GmailMcpService({
  search: async (userId, query, signal) => {
    signal?.throwIfAborted();
    const access = await gmailAccess(userId);
    if (!access.connected) throw new Error('Reconnect Gmail in Settings.');
    signal?.throwIfAborted();
    if (access.provider === 'browser') return searchBrowserGmail(userId, query, signal);
    return apiReader.search(userId, query, signal);
  },
  thread: async (userId, threadId, signal) => {
    signal?.throwIfAborted();
    const access = await gmailAccess(userId);
    if (!access.connected) throw new Error('Reconnect Gmail in Settings.');
    signal?.throwIfAborted();
    if (access.provider === 'browser') return readBrowserGmail(userId, threadId, signal);
    return apiReader.thread(userId, threadId, signal);
  },
  send: sendApprovedApplicationEmail,
});
export async function gmailRunConnection(userId: string, approvals: string[] = [], browserPort?: number) {
  const status = await gmailAccess(userId);
  const empty = { GMAIL_MCP_URL: '', GMAIL_MCP_TOKEN: '', GMAIL_MCP_ACCOUNT: '', GMAIL_ACCESS_MODE: status.provider };
  if (!status.connected || !status.account) return { env: empty, revoke: () => {} };
  const stopBrowser = status.provider === 'browser' && browserPort ? registerGmailBrowser(userId, browserPort, status.account) : () => {};
  const grant = await gmailMcp.grant(userId, status.account, approvals);
  return { env: { GMAIL_MCP_URL: grant.connection.url, GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account, GMAIL_ACCESS_MODE: status.provider }, revoke: () => { grant.revoke(); stopBrowser(); } };
}
export async function checkGmailMcp(userId: string): Promise<void> {
  const status = await gmailConnection(userId);
  if (!status.connected || !status.account) throw new Error('Gmail is not connected.');
  const grant = await gmailMcp.grant(userId, status.account);
  const lease = { env: { GMAIL_MCP_URL: grant.connection.url, GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account }, revoke: grant.revoke };
  if (!lease.env.GMAIL_MCP_URL) throw new Error('Gmail is not connected.');
  const client = new GmailMcpClient({ url: lease.env.GMAIL_MCP_URL, token: lease.env.GMAIL_MCP_TOKEN, account: lease.env.GMAIL_MCP_ACCOUNT });
  try { await client.search('subject:"Owtomate connection check"'); }
  finally { await client.close(); lease.revoke(); }
}
