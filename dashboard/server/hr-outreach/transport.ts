import { createHash } from 'node:crypto';
import { one } from '../db/index.js';
import { gmailAccess } from '../gmail-access.js';
import { gmailRequest } from '../gmail-connection.js';
import { hrOutreachAllowed, HR_OUTREACH_ACCESS_MESSAGE } from './access.js';
import { GmailServiceError } from '../../../seek-bot/src/gmail-mcp-service.js';
import { validApplicationEmail } from '../../../seek-bot/src/application-email-message.js';
import { hrMailBody, hrMailReference, validateHrMail, sendHrMailInBrowser, reconcileBrowserHrEmail, sendBrowserHrEmail, openHrGmail, reconcileHrEmailOnPage, type BrowserHrMail } from '../../../seek-bot/src/hr-email-browser.js';
import type { HrBrowserPage as Page } from '../../../seek-bot/src/hr-email-browser.js';

export type HrMail = BrowserHrMail;
export const hrDeliveredBody = hrMailBody;
export interface HrReceipt { messageId: string; threadId?: string; alreadySent?: boolean }
export const hrMessageId = (id: string) => `<${createHash('sha256').update(`hr:${id}`).digest('hex')}@outreach.owtomate.com>`;

/** Plain-text only: no remote images, tracking pixels or hidden attachments. */
export function hrEmailMessage(mail: HrMail, from: string): string {
  validateHrMail(mail);
  if (!validApplicationEmail(from)) throw new GmailServiceError('reconnect', 'Connect your profile Gmail address.');
  const encoded = Buffer.from(hrMailBody(mail)).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return Buffer.from([`From: <${from}>`, `To: <${mail.to}>`, `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=`,
    `Message-ID: ${hrMessageId(mail.id)}`, `X-Owtomate-HR: ${hrMailReference(mail.id)}`, `Date: ${new Date(mail.createdAt).toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded, ''].join('\r\n')).toString('base64url');
}

export interface HrTransportDependencies {
  allowed: (userId: string) => Promise<boolean>;
  access: typeof gmailAccess;
  owner: (userId: string) => Promise<{ email: string } | null>;
  request: typeof gmailRequest;
  sendBrowser: typeof sendHrMailInBrowser;
  reconcileBrowser: typeof reconcileBrowserHrEmail;
  withBrowser?: <T>(action: (page: Page) => Promise<T>) => Promise<T>;
}
const defaults: HrTransportDependencies = { allowed: hrOutreachAllowed, access: gmailAccess, owner: userId => one('SELECT email FROM profiles WHERE user_id=$1', [userId]), request: gmailRequest,
  sendBrowser: sendHrMailInBrowser, reconcileBrowser: reconcileBrowserHrEmail };

export function createHrTransport(deps: HrTransportDependencies = defaults) {
  const identity = async (userId: string) => {
    if (!await deps.allowed(userId)) throw new GmailServiceError('unapproved', HR_OUTREACH_ACCESS_MESSAGE);
    const [connection, owner] = await Promise.all([deps.access(userId), deps.owner(userId)]);
    if (!connection.connected || !connection.account || !owner?.email || owner.email.trim().toLowerCase() !== connection.account.toLowerCase()) throw new GmailServiceError('reconnect', 'Connect the Gmail address saved in your application profile.');
    return connection as typeof connection & { account: string };
  };
  return {
    async send(userId: string, mail: HrMail): Promise<HrReceipt> {
      validateHrMail(mail);
      const connection = await identity(userId);
      let browserSendInvoked = false;
      try {
        const receipt: { id: string; threadId?: string } = connection.provider === 'browser' ? deps.withBrowser
          ? await deps.withBrowser(async page => { await openHrGmail(page, connection.account); browserSendInvoked = true; return sendBrowserHrEmail(page, mail, connection.account); })
          : await deps.sendBrowser(userId, mail, connection.account)
          : await deps.request<{ id: string; threadId?: string }>(userId, 'messages/send', { method: 'POST', data: { raw: hrEmailMessage(mail, connection.account) } });
        if (!receipt.id) throw new GmailServiceError('uncertain', 'Gmail returned no HR email receipt.');
        return { messageId: receipt.id, threadId: receipt.threadId };
      } catch (error) {
        if (error instanceof GmailServiceError && ['unapproved', 'reconnect', 'uncertain'].includes(error.code)) throw error;
        if (connection.provider === 'browser' && deps.withBrowser && !browserSendInvoked) throw Object.assign(new GmailServiceError('unavailable', 'The private Gmail browser was unavailable before sending.'), { definitiveRejection: true, cause: error });
        const status = (error as { providerStatus?: number }).providerStatus;
        if (status !== undefined && status >= 400 && status < 500) throw Object.assign(new GmailServiceError('unavailable', 'Gmail rejected the HR email. Retry after reconnecting or waiting.'), { definitiveRejection: true, cause: error });
        throw Object.assign(new GmailServiceError('uncertain', 'The HR email send could not be confirmed.'), {cause: error});
      }
    },
    async reconcile(userId: string, mail: HrMail): Promise<HrReceipt | null> {
      validateHrMail(mail);
      const connection = await identity(userId);
      if (connection.provider === 'browser') {
        const receipt = deps.withBrowser ? await deps.withBrowser(page => reconcileHrEmailOnPage(page, mail, connection.account)) : await deps.reconcileBrowser(userId, mail, connection.account);
        return receipt ? { messageId: receipt.id, threadId: receipt.threadId, alreadySent: true } : null;
      }
      const signal = AbortSignal.timeout(60_000);
      const found = await deps.request<{ messages?: Array<{ id: string }> }>(userId, 'messages', { params: {
        q: `in:sent rfc822msgid:${hrMessageId(mail.id)}`, maxResults: 10,
      }, signal });
      let candidates = found.messages || [];
      if (!candidates.length) {
        const after = Math.floor((Date.parse(mail.createdAt) - 5 * 60_000) / 1000);
        const fallback = await deps.request<{ messages?: Array<{ id: string }> }>(userId, 'messages', { params: { q: `in:sent to:${mail.to} after:${after}`, maxResults: 100 }, signal });
        candidates = fallback.messages || [];
      }
      for (const candidate of candidates) {
        signal.throwIfAborted();
        const metadata = await deps.request<{ id: string; threadId?: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } }>(
          userId, `messages/${encodeURIComponent(candidate.id)}`, { params: { format: 'metadata' }, signal });
        const headers = metadata.payload?.headers || [], header = (name: string) => headers.find(h => h.name.toLowerCase() === name)?.value;
        if (metadata.labelIds?.includes('SENT') && (header('x-owtomate-hr') === hrMailReference(mail.id)
          || header('message-id') === hrMessageId(mail.id) || header('x-google-original-message-id') === hrMessageId(mail.id))) {
          return { messageId: metadata.id, threadId: metadata.threadId, alreadySent: true };
        }
      }
      return null;
    },
  };
}
export const sendHrEmail = (userId: string, mail: HrMail, options: Pick<HrTransportDependencies, 'withBrowser'> = {}) => createHrTransport({ ...defaults, ...options }).send(userId, mail);
export const reconcileHrEmail = (userId: string, mail: HrMail, options: Pick<HrTransportDependencies, 'withBrowser'> = {}) => createHrTransport({ ...defaults, ...options }).reconcile(userId, mail);
