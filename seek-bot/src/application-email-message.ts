import { createHash } from 'node:crypto';
import type { PreparedApplication } from './application-review-types.js';

export const validApplicationEmail = (value: string) => value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
export const applicationEmailMessageId = (id: string, revision: string) => `<${createHash('sha256').update(`${id}:${revision}`).digest('hex')}@applications.owtomate.com>`;
const base64Lines = (data: Buffer) => data.toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';

/** RFC 2045 multipart data; no browser or mailto handler participates. */
export function applicationEmailMessage(draft: PreparedApplication, from: string, resume: Buffer, filename: string): string {
  if (!draft.email || !validApplicationEmail(from) || !validApplicationEmail(draft.email.to)
    || !draft.coverLetter?.trim() || !draft.email.subject.trim() || /[\r\n]/.test(draft.email.subject)
    || Buffer.byteLength(draft.email.subject) > 300 || resume.length > 10_000_000) throw new Error('Invalid approved email application.');
  const boundary = `owtomate_${createHash('sha256').update(`${draft.id}:${draft.revision}`).digest('hex').slice(0, 40)}`;
  const lines = [`From: <${from}>`, `To: <${draft.email.to}>`,
    `Subject: =?UTF-8?B?${Buffer.from(draft.email.subject).toString('base64')}?=`,
    `Message-ID: ${applicationEmailMessageId(draft.id, draft.revision)}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(draft.coverLetter))];
  const attachment = (name: string, content: Buffer, mime: string) => {
    const safe = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80) || 'attachment';
    const encoded = encodeURIComponent(name.slice(0, 150)).replace(/'/g, '%27');
    lines.push(`--${boundary}`, `Content-Type: ${mime}`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safe}"; filename*=UTF-8''${encoded}`, '', base64Lines(content));
  };
  attachment(filename, resume, 'application/octet-stream');
  if (draft.email.attachCoverLetter) attachment('Cover letter.txt', Buffer.from(draft.coverLetter), 'text/plain; charset=UTF-8');
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
