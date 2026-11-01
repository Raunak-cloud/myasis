import type { GmailMessage } from '../../seek-bot/src/gmail-mcp-client.js';
import { verificationMailboxQuery, verificationMailboxMessageAllowed } from '../../seek-bot/src/gmail-verification-policy.js';
import type { gmailRequest } from './gmail-connection.js';

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

/** The caller checks candidate access; the injected transport remains bound to
 * that user's OAuth grant. Kept separate so real API parameters and mixed
 * conversation labels can be exercised without a live Google account. */
export function gmailApiReader(request: typeof gmailRequest) {
  return {
    async search(userId: string, query: string) {
      const found = await request<{ threads?: Array<{ id: string }> }>(userId, 'threads', {
        params: { q: verificationMailboxQuery(query), includeSpamTrash: 'true', maxResults: 20 },
      });
      return found.threads || [];
    },
    async thread(userId: string, threadId: string) {
      const thread = await request<{ messages?: Array<Record<string, any>> }>(userId, `threads/${encodeURIComponent(threadId)}`, { params: { format: 'full' } });
      return (thread.messages || []).map(gmailApiMessage).filter(message =>
        verificationMailboxMessageAllowed(message)
        && Date.parse(message.date || '') > Date.now() - 2 * 60 * 60_000).slice(-20);
    },
  };
}
