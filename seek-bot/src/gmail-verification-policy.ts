import type { GmailMessage } from './gmail-mcp-client.js';

/** Read verification mail in ordinary folders and Spam, never deleted or sent
 * mail. Shared by the browser and OAuth adapters; no mailbox state is changed. */
export function verificationMailboxQuery(query: string, now = Date.now()): string {
  const earliest = Math.floor((now - 2 * 60 * 60_000) / 1000);
  return `in:anywhere -in:trash -in:sent -in:draft after:${earliest} (${query})`;
}

/** Gmail's UI can return a false empty result for combined folder exclusions.
 * Keep one chronological candidate search and subtract positive folder sets;
 * the API can continue using its supported compound query. */
export function verificationBrowserSearchPlan(query: string, now = Date.now()) {
  const tail = `after:${Math.floor((now - 2 * 60 * 60_000) / 1000)} (${query})`;
  return { primary: verificationMailboxQuery(query, now), candidates: `in:anywhere ${tail}`,
    excluded: ['trash', 'sent', 'draft'].map(folder => `in:${folder} ${tail}`) };
}

export function verificationMailboxMessageAllowed(message: Pick<GmailMessage, 'labelIds'>): boolean {
  return !message.labelIds?.some(label => ['SENT', 'DRAFT', 'TRASH'].includes(label));
}
