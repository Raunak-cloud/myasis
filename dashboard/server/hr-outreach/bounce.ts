import { one } from '../db/index.js';
import { gmailAccess } from '../gmail-access.js';
import { gmailRequest } from '../gmail-connection.js';
import { hrOutreachAllowed, HR_OUTREACH_ACCESS_MESSAGE } from './access.js';
import { GmailServiceError } from '../../../seek-bot/src/gmail-mcp-service.js';
import { hrMailBody, hrMailReference, validateHrMail, type HrBrowserPage } from '../../../seek-bot/src/hr-email-browser.js';
import { hrMessageId, type HrMail } from './transport.js';
import { readHrBounceMessagesOnPage, type HrRawMailboxMessage } from './bounce-browser.js';

export interface HrBounce {
  kind: 'invalid_recipient' | 'temporary_failure' | 'policy_rejection';
  action: 'failed' | 'delayed';
  recipient: string;
  diagnosticCode: string;
  reason: string;
  noticeMessageId: string;
  threadId?: string;
  observedAt: string;
}
export interface HrBounceOptions {
  sentAt: string;
  threadId?: string;
  signal?: AbortSignal;
  withBrowser?: <T>(action: (page: HrBrowserPage) => Promise<T>) => Promise<T>;
}
export interface HrBounceDependencies {
  allowed: (userId: string) => Promise<boolean>;
  access: typeof gmailAccess;
  owner: (userId: string) => Promise<{ email: string } | null>;
  request: typeof gmailRequest;
  readBrowser: typeof readHrBounceMessagesOnPage;
  now: () => Date;
}
interface MimePart { headers: Map<string, string[]>; mime: string; body: string; children: MimePart[] }
const MAX_RAW = 2_000_000;
const emailPattern = /[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;
const addresses = (value: string) => [...new Set((value.match(emailPattern) ?? []).map(email => email.toLowerCase()))];
const header = (part: MimePart, name: string) => part.headers.get(name.toLowerCase())?.[0] ?? '';
// Gmail's RFC message text/plain part folds paragraph spaces into line breaks.
// Compare the complete token sequence, never a subject/reference substring.
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function headers(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of text.slice(0, 100_000).replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const match = /^([A-Za-z0-9-]{1,100}):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), values = result.get(key) ?? [];
    if (values.length < 10) values.push(match[2].slice(0, 20_000));
    result.set(key, values);
  }
  return result;
}
function quotedPrintable(text: string): string {
  const binary = text.replace(/=\r?\n/g, '').replace(/=([A-F0-9]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(binary, 'latin1').toString('utf8');
}
function decodeHeader(text: string): string {
  return text.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (all, charset: string, encoding: string, encoded: string) => {
    if (!/^(?:utf-8|us-ascii|iso-8859-1)$/i.test(charset)) return all;
    const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(encoded, 'base64') : Buffer.from(encoded.replace(/_/g, ' ').replace(/=([A-F0-9]{2})/gi, (_all: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    return bytes.toString(/^iso/i.test(charset) ? 'latin1' : 'utf8');
  });
}
function parseMime(raw: string, budget = { parts: 0 }, depth = 0): MimePart | null {
  if (raw.length > MAX_RAW || depth > 8 || ++budget.parts > 64) return null;
  const normalized = raw.replace(/\r\n/g, '\n'), split = normalized.indexOf('\n\n');
  if (split < 0) return null;
  const parsedHeaders = headers(normalized.slice(0, split));
  let body = normalized.slice(split + 2);
  const type = parsedHeaders.get('content-type')?.[0] ?? 'text/plain', mime = type.split(';')[0].trim().toLowerCase();
  const encoding = parsedHeaders.get('content-transfer-encoding')?.[0]?.toLowerCase();
  if (encoding === 'base64') { if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) return null; body = Buffer.from(body, 'base64').toString('utf8'); }
  else if (encoding === 'quoted-printable') body = quotedPrintable(body);
  const part: MimePart = { headers: parsedHeaders, mime, body, children: [] };
  if (mime.startsWith('multipart/')) {
    const boundary = /\bboundary\s*=\s*(?:"([^"\r\n]{1,200})"|([^;\s]{1,200}))/i.exec(type);
    if (!boundary) return null;
    const sections = body.split(new RegExp(`(?:^|\\n)--${escapeRegex(boundary[1] ?? boundary[2])}(?:--)?[ \\t]*(?:\\n|$)`));
    for (const section of sections.slice(1, 65)) { const child = parseMime(section, budget, depth + 1); if (child) part.children.push(child); }
  } else if (mime === 'message/rfc822' || mime === 'message/global') {
    const child = parseMime(body, budget, depth + 1); if (child) part.children.push(child);
  }
  return part;
}
function plainBody(part: MimePart): string {
  if (part.mime === 'text/plain') return part.body;
  for (const child of part.children) { const body = plainBody(child); if (body) return body; }
  return '';
}
function originalMatches(part: MimePart, mail: HrMail, account: string, requireBody: boolean): boolean {
  const to = addresses(header(part, 'to')), from = addresses(header(part, 'from'));
  return to.length === 1 && to[0] === mail.to.toLowerCase() && from.length === 1 && from[0] === account.toLowerCase()
    && decodeHeader(header(part, 'subject')) === mail.subject
    && (!requireBody || normalize(plainBody(part)) === normalize(hrMailBody(mail)));
}
function trustedSystemNotice(part: MimePart): boolean {
  const from = addresses(header(part, 'from'));
  if (from.length !== 1 || !/^(?:postmaster|mailer-daemon)@/i.test(from[0])) return false;
  if (header(part, 'return-path').trim() !== '<>' && !/^auto-(?:generated|replied)(?:\s|;|$)/i.test(header(part, 'auto-submitted'))) return false;
  // Use Gmail's own receiving authentication result, never a result copied
  // into an attached original or supplied as human-readable message prose.
  const authentication = (part.headers.get('authentication-results') ?? []).find(value => /^mx\.google\.com\s*;/i.test(value));
  if (!authentication) return false;
  const senderDomain = from[0].split('@')[1], aligned = (value: string) => value === senderDomain || value.endsWith(`.${senderDomain}`)
    || /^(?:googlemail\.com|google\.com)$/.test(senderDomain) && /(?:^|\.)(?:googlemail\.com|google\.com)$/.test(value);
  for (const mechanism of authentication.split(';').slice(1)) {
    if (!/\b(?:dkim|spf|dmarc)=pass\b/i.test(mechanism)) continue;
    const domains = [...mechanism.matchAll(/(?:header\.(?:d|i|from)|smtp\.(?:mailfrom|helo))\s*=\s*<?(?:[^@\s;<>]*@)?([a-z0-9.-]+)>?/gi)].map(match => match[1].toLowerCase());
    if (domains.some(aligned)) return true;
  }
  return false;
}

/** Some authenticated Exchange NDRs declare an empty delivery-status part.
 * Read only their labelled technical report, excluding quoted original data. */
function exchangeDeliveryBlocks(part: MimePart, mail: HrMail): Map<string, string[]>[] | null {
  if (header(part, 'return-path').trim() !== '<>' || !/^auto-(?:generated|replied)(?:\s|;|$)/i.test(header(part, 'auto-submitted'))) return null;
  const human = part.children.filter(child => !['message/rfc822', 'message/global', 'message/delivery-status'].includes(child.mime)).map(plainBody).find(Boolean);
  if (!human) return null;
  const report = human.split(/^Original Message Headers\s*:?\s*$/im)[0];
  if (!/\b(?:Office|Microsoft) 365\b/i.test(report) || !/^Original Message Details\s*$/im.test(report)) return null;
  const heading = /^Your message to\s+([^\r\n]+?)\s+could(?:n['’]t| not) be delivered[.!]?\s*$/im.exec(report);
  if (!heading || addresses(heading[1]).join(',') !== mail.to.toLowerCase()) return null;
  const recipient = /^Recipient Address\s*:\s*([^\r\n]+)$/im.exec(report);
  if (!recipient || addresses(recipient[1]).join(',') !== mail.to.toLowerCase()) return null;
  const technical = /(?:^|\n)Error Details\s*\n([\s\S]*?)(?:\n(?:Original Message Headers|Notification Details|Message Hops)\b|$)/i.exec(report)?.[1];
  const error = technical && /(?:^|\n)Error\s*:\s*([^\n]*(?:\n(?![A-Za-z][A-Za-z ]{1,40}:|\s*$)[^\n]*)*)/i.exec(technical)?.[1]?.slice(0, 2_000);
  if (!error || addresses(error).some(value => value !== mail.to.toLowerCase())) return null;
  for (const match of report.matchAll(/^(?:Final[- ]Recipient|Forward(?:ed|ing)[- ](?:Recipient|Address))\s*:\s*([^\r\n]+)$/gim)) {
    if (addresses(match[1]).some(value => value !== mail.to.toLowerCase())) return null;
  }
  const status = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(error)?.[1];
  if (!status || !/\b550\b/.test(error) || status !== '5.1.1'
    || !/user unknown|unknown (?:user|recipient)|(?:account|address|mailbox|user|recipient).{0,80}(?:does not exist|not found|not exist)|no such (?:user|recipient|mailbox)/i.test(error)) return null;
  return [headers('Reporting-MTA: dns; authenticated-exchange-report'), headers(`Final-Recipient: rfc822; ${mail.to}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; ${error.replace(/\n/g, ' ')}`)];
}

/** Structured DSNs only. A quoted subject, reference or error phrase in a
 * normal email is never enough to declare another person's address invalid. */
export function parseHrBounce(mail: HrMail, account: string, messages: HrRawMailboxMessage[], options: Pick<HrBounceOptions, 'sentAt'> & { now?: Date }): HrBounce | null {
  validateHrMail(mail);
  const sentAt = Date.parse(options.sentAt), now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(sentAt) || !Number.isFinite(now) || sentAt > now + 60_000) return null;
  const parsed = messages.slice(0, 30).flatMap(message => { const part = parseMime(message.raw); return part ? [{ message, part }] : []; });
  const originals = new Set<string>([hrMessageId(mail.id)]);
  let ownSent = false;
  for (const { message, part } of parsed) {
    if (part.mime === 'multipart/report' || !message.labelIds?.includes('SENT') || !originalMatches(part, mail, account, true)) continue;
    const at = Date.parse(message.receivedAt ?? header(part, 'date'));
    if (!Number.isFinite(at) || Math.abs(at - sentAt) > 5 * 60_000) continue;
    ownSent = true; const id = header(part, 'message-id').trim(); if (id) originals.add(id);
  }
  if (!ownSent) return null;
  let latest: HrBounce | null = null;
  for (const { message, part } of parsed) {
    const at = Date.parse(message.receivedAt ?? header(part, 'date'));
    if (!message.id || message.id.length > 200 || !Number.isFinite(at) || at < sentAt - 5 * 60_000 || at > now + 60_000
      || !addresses(header(part,'to')).includes(account.toLowerCase()) || part.mime !== 'multipart/report'
      || !/\breport-type\s*=\s*"?delivery-status\b/i.test(header(part, 'content-type')) || !trustedSystemNotice(part)) continue;
    const delivery = part.children.find(child => child.mime === 'message/delivery-status');
    if (!delivery) continue;
    const blocks = delivery.body.trim() ? delivery.body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map(headers) : exchangeDeliveryBlocks(part, mail);
    if (!blocks) continue;
    if (!blocks[0]?.get('reporting-mta')?.length) continue;
    const returned = part.children.flatMap(child => child.mime === 'message/rfc822' || child.mime === 'message/global' ? child.children : child.mime === 'text/rfc822-headers'
      ? [{ headers: headers(child.body), mime: 'text/rfc822-headers', body: '', children: [] } as MimePart] : []);
    const correlation = returned.some(original => originalMatches(original, mail, account, false)
      && (originals.has(header(original, 'message-id').trim()) || header(original, 'x-owtomate-hr') === hrMailReference(mail.id)
        && normalize(plainBody(original)) === normalize(hrMailBody(mail))));
    if (!correlation) continue;
    const recipient = (block: Map<string, string[]>, name: string) => addresses((block.get(name)?.[0] ?? '').replace(/^[^;]*;/, ''));
    const conflict = blocks.some(block => recipient(block, 'original-recipient').includes(mail.to.toLowerCase()) && !recipient(block, 'final-recipient').includes(mail.to.toLowerCase()));
    if (conflict) continue;
    for (const block of blocks.slice(1)) {
      const final = recipient(block, 'final-recipient'), original = recipient(block, 'original-recipient');
      if (final.length !== 1 || final[0] !== mail.to.toLowerCase() || original.length && (original.length !== 1 || original[0] !== final[0])) continue;
      const action = block.get('action')?.[0]?.trim().toLowerCase(), status = block.get('status')?.[0]?.trim(), diagnostic = block.get('diagnostic-code')?.[0] ?? '';
      if ((action !== 'failed' && action !== 'delayed') || !status || !/^[245]\.\d{1,3}\.\d{1,3}$/.test(status)) continue;
      let kind: HrBounce['kind'], reason: string;
      if (action === 'failed' && status === '5.1.1' && /^smtp\s*;/i.test(diagnostic) && /\b550\b/.test(diagnostic) && /\b5\.1\.1\b/.test(diagnostic)
        && /user unknown|unknown (?:user|recipient)|recipient (?:unknown|not found)|(?:account|address|mailbox|user|recipient).{0,80}(?:does not exist|not found|not exist)|no such (?:user|recipient|mailbox)/i.test(diagnostic)) {
        kind = 'invalid_recipient'; reason = 'The receiving mail server reported that this email address does not exist.';
      } else if (status.startsWith('4.')) { kind = 'temporary_failure'; reason = action === 'delayed' ? 'The mail server delayed delivery because of a temporary problem.' : 'The mail server reported a temporary delivery failure.'; }
      else if (status.startsWith('5.7.')) { kind = 'policy_rejection'; reason = 'The receiving mail server rejected this email under its delivery policy.'; }
      else continue;
      const notice: HrBounce = { kind, action, recipient: final[0], diagnosticCode: `${/\b[245]\d\d\b/.exec(diagnostic)?.[0] ?? ''} ${status}`.trim(), reason,
        noticeMessageId: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), observedAt: new Date(at).toISOString() };
      // Gmail threads are chronological. An old delay must not hide a later
      // terminal failure, even when another delay is the newest message.
      if (!latest || notice.action === 'failed' && latest.action !== 'failed'
        || notice.action === latest.action && at > Date.parse(latest.observedAt)) latest = notice;
    }
  }
  return latest;
}

const defaults: HrBounceDependencies = { allowed: hrOutreachAllowed, access: gmailAccess, owner: userId => one('SELECT email FROM profiles WHERE user_id=$1', [userId]), request: gmailRequest,
  readBrowser: readHrBounceMessagesOnPage, now: () => new Date() };
export function createHrBounceChecker(deps: HrBounceDependencies = defaults) {
  return async (userId: string, mail: HrMail, options: HrBounceOptions): Promise<HrBounce | null> => {
    validateHrMail(mail);
    if (!await deps.allowed(userId)) throw new GmailServiceError('unapproved', HR_OUTREACH_ACCESS_MESSAGE);
    const [access, owner] = await Promise.all([deps.access(userId), deps.owner(userId)]);
    if (!access.connected || !access.account || !owner?.email || access.account.toLowerCase() !== owner.email.trim().toLowerCase()) throw new GmailServiceError('reconnect', 'Connect the Gmail address saved in your application profile.');
    const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(options.signal ? [options.signal] : [])]);
    const at = Date.parse(options.sentAt); if (!Number.isFinite(at)) throw new GmailServiceError('unapproved', 'The HR email has no recorded send time.');
    let messages: HrRawMailboxMessage[];
    if (access.provider === 'browser') {
      if (!options.withBrowser) throw new GmailServiceError('unavailable', 'The private Gmail reader is unavailable.');
      messages = await options.withBrowser(page => deps.readBrowser(page, mail, access.account!, { ...options, signal }));
    } else {
      const ids = new Set<string>(), after = Math.floor((at - 5 * 60_000) / 1000);
      for (const q of [`in:sent after:${after} "${hrMailReference(mail.id)}"`, `in:anywhere after:${after} {from:postmaster from:mailer-daemon} "${mail.to}"`]) {
        const found = await deps.request<{ messages?: Array<{ id: string }> }>(userId, 'messages', { params: { q, maxResults: 15 }, signal });
        for (const message of found.messages ?? []) if (/^[\w-]{1,100}$/.test(message.id)) ids.add(message.id);
      }
      messages = [];
      for (const id of [...ids].slice(0, 25)) {
        const message = await deps.request<{ id: string; threadId?: string; internalDate?: string; raw?: string; labelIds?: string[] }>(userId, `messages/${encodeURIComponent(id)}`, { params: { format: 'raw' }, signal });
        if (!message.raw || message.raw.length > 3_000_000) continue;
        const raw = Buffer.from(message.raw, 'base64url').toString('utf8'); if (raw.length > MAX_RAW) continue;
        const received = Number(message.internalDate);
        messages.push({ id: message.id, threadId: message.threadId, raw, labelIds: message.labelIds,
          ...(Number.isFinite(received) ? { receivedAt: new Date(received).toISOString() } : {}) });
      }
    }
    return parseHrBounce(mail, access.account, messages, { sentAt: options.sentAt, now: deps.now() });
  };
}
export const checkHrBounce = (userId: string, mail: HrMail, options: HrBounceOptions) => createHrBounceChecker()(userId, mail, options);
