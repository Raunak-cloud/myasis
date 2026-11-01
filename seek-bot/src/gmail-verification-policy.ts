import type { GmailMessage } from './gmail-mcp-client.js';

/** Read verification mail in ordinary folders and Spam, never deleted or sent
 * mail. Shared by the browser and OAuth adapters; no mailbox state is changed. */
export function verificationMailboxQuery(query: string, now = Date.now()): string {
  const earliest = Math.floor((now - 2 * 60 * 60_000) / 1000);
  return `in:anywhere -in:trash -in:sent -in:draft after:${earliest} (${query})`;
}

export function verificationMailboxMessageAllowed(message: Pick<GmailMessage, 'labelIds'>): boolean {
  return !message.labelIds?.some(label => ['SENT', 'DRAFT', 'TRASH'].includes(label));
}
