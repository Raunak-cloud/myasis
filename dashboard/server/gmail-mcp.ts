import { gmailConnection, gmailRequest } from './gmail-connection.js';
import { sendApprovedApplicationEmail } from './application-email.js';
import { GmailMcpService } from '../../seek-bot/src/gmail-mcp-service.js';
import { GmailMcpClient, type GmailMessage } from '../../seek-bot/src/gmail-mcp-client.js';
import { gmailAccess } from './gmail-access.js';
import { registerGmailBrowser, searchBrowserGmail, readBrowserGmail } from '../../seek-bot/src/gmail-browser.js';

function gmailApiMessage(raw: Record<string, any>): GmailMessage {
  const headers = raw.payload?.headers || [];
  const header = (name: string) => headers.find((entry: { name: string }) => entry.name?.toLowerCase() === name)?.value || '';
  const text: string[] = [], html: string[] = [];
  const read = (part: Record<string, any>) => {
    if (!part.filename && typeof part.body?.data === 'string') {
      const value = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') text.push(value);
      if (part.mimeType === 'text/html') html.push(value);
    }
    for (const child of part.parts || []) read(child);
  };
  if (raw.payload) read(raw.payload);
  const stamp = Number(raw.internalDate);
  return { id: String(raw.id), subject: header('subject'), sender: header('from'),
    date: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : header('date'),
    plaintextBody: text.join('\n').slice(0, 20_000), htmlBody: html.join('\n').slice(0, 80_000), snippet: raw.snippet, labelIds: raw.labelIds };
}
const gmailMcp = new GmailMcpService({
  search: async (userId, query) => {
    const access = await gmailAccess(userId);
    if (!access.connected) throw new Error('Reconnect Gmail in Settings.');
    if (access.provider === 'browser') return searchBrowserGmail(userId, query);
    const found = await gmailRequest<{ threads?: Array<{ id: string }> }>(userId, 'threads', {
      params: { q: `newer_than:2h -in:sent -in:draft (${query})`, maxResults: 20 } });
    return found.threads || [];
  },
  thread: async (userId, threadId) => {
    const access = await gmailAccess(userId);
    if (!access.connected) throw new Error('Reconnect Gmail in Settings.');
    if (access.provider === 'browser') return readBrowserGmail(userId, threadId);
    const thread = await gmailRequest<{ messages?: Array<Record<string, any>> }>(userId, `threads/${encodeURIComponent(threadId)}`, { params: { format: 'full' } });
    return (thread.messages || []).map(gmailApiMessage).filter(message =>
      !message.labelIds?.some(label => ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label))
      && Date.parse(message.date || '') > Date.now() - 2 * 60 * 60_000).slice(-20);
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
