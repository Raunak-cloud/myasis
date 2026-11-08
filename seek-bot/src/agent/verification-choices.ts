import { randomUUID } from 'node:crypto';
import type { LocalVerificationEmail } from '../verification-email-local.js';

const token = /\b(?:\d{4}[ -]\d{4}|\d{3}[ -]\d{3}|[A-Z0-9]{4,12}(?:-[A-Z0-9]{3,6})?)\b/gi;
const normalize = (value: string) => /^\d[\d -]+$/.test(value) ? value.replace(/[ -]/g, '') : value;
export type PrivateVerificationChoice = { kind: 'code' | 'link'; value: string; subject: string };

/** The applying agent selects opaque IDs. Credential values stay in memory. */
export class VerificationChoices {
  private readonly values = new Map<string, { scope: string; expires: number; choice: PrivateVerificationChoice }>();

  present(messages: Array<{ email: LocalVerificationEmail; date?: string }>, scope: string) {
    const now = Date.now();
    for (const [id, value] of this.values) if (value.expires <= now) this.values.delete(id);
    return messages.map(({ email, date }) => {
      const codes = new Map<string, string>();
      const candidates: Array<{ credential_id: string; kind: 'code' | 'link'; characters?: number; label?: string; host?: string; path?: string }> = [];
      const stamp = Date.parse(date || '');
      const expires = Number.isFinite(stamp) ? Math.min(now + 15 * 60000, stamp + 15 * 60000) : now + 15 * 60000;
      const add = (kind: 'code' | 'link', value: string) => {
        const id = `mail_${randomUUID()}`;
        this.values.set(id, { scope, expires, choice: { kind, value, subject: email.subject } });
        return id;
      };
      const withoutAddresses = `${email.subject}\n${email.text}`.replace(/https?:\/\/[^\s<>"']+/gi, '').replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g, '');
      for (const match of withoutAddresses.matchAll(token)) {
        if (!/\d/.test(match[0])) continue;
        const value = normalize(match[0]);
        if (codes.has(value) || codes.size >= 24) continue;
        const id = add('code', value); codes.set(value, id);
        candidates.push({ credential_id: id, kind: 'code', characters: value.length });
      }
      const scrub = (text: string) => text.replace(/https?:\/\/[^\s<>"']+/gi, '[private-url]')
        .replace(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g, '[private-address]')
        .replace(token, word => /\d/.test(word) ? `[${codes.get(normalize(word)) || 'private-number'}]` : word)
        .replace(/\b[A-Za-z0-9_-]{4,}\b/g, word => word.startsWith('mail_') || !/\d/.test(word) ? word : '[private-token]');
      for (const link of email.links.slice(0, 40)) {
        let url: URL; try { url = new URL(link.url); } catch { continue; }
        if (url.protocol !== 'https:' || url.username || url.password) continue;
        candidates.push({ credential_id: add('link', url.href), kind: 'link', label: scrub(link.text), host: url.hostname,
          path: url.pathname.split('/').map(part => /^(?:verify|verification|activate|activation|confirm|confirmation|reset|password|login|signin|auth|account|career)$/i.test(part) ? part : part ? '[private-path]' : '').join('/').slice(0, 200) });
      }
      for (const candidate of candidates) this.values.get(candidate.credential_id)!.choice.subject = scrub(email.subject);
      return { sender: email.sender || '', subject: scrub(email.subject), date: date || null,
        text: scrub(email.text).slice(0, 12000), candidates };
    });
  }

  select(id: string, scope: string): PrivateVerificationChoice | null {
    const value = this.values.get(id);
    return value && value.scope === scope && value.expires > Date.now() ? value.choice : null;
  }
}
