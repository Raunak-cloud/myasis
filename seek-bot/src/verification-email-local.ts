import type { VerificationEmail } from './llm.js';

export function verificationContextWords(ask: { hint?: string; site?: string }): string[] {
  return [...new Set(`${ask.site || ''} ${ask.hint || ''}`.toLowerCase().replace(/https?:\/\//g, '').split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !['www', 'com', 'net', 'org', 'sign', 'login', 'email', 'verification', 'code', 'account', 'site', 'the', 'application'].includes(word)))];
}

/** Parse untrusted mailbox text as data. No prompts or mailbox bodies go to an AI service. */
export function readVerificationEmailsLocally(emails: VerificationEmail[], ask: { hint?: string; site?: string; want: 'code' | 'link' | 'either' }) {
  const words = verificationContextWords(ask);
  if (!words.length) return null;
  for (const email of emails) {
    const content = `${email.subject}\n${email.text}`;
    if (!words.some(word => new RegExp(`\\b${word}\\b`, 'i').test(content))) continue;
    if (!/verif|passcode|one.time|security code|sign.in|activation|confirm|reset.*password/i.test(content)) continue;
    if (ask.want !== 'link') {
      const patterns = [/(?:verification|security|sign.in|login|one.time|confirmation|access|authentication|passcode|OTP)[^\n]{0,45}?(?:code|password|pin)?\s*[:\-]?\s*\n?\s*\b(\d{3}[ -]?\d{3}|\d{4,8})\b/i,
        /\b(\d{3}[ -]?\d{3}|\d{4,8})\b[^\n]{0,35}(?:verification code|security code|sign.in code|one.time code)/i,
        /\buse\s+(\d{3}[ -]?\d{3}|\d{4,8})\s+to\s+(?:verify|confirm|sign.in|log.in)/i,
        /(?:code|passcode|OTP)\s*(?:is|:|-)?\s*([A-Z0-9]{4,12}(?:-[A-Z0-9]{3,6})?)\b/i];
      for (const pattern of patterns) {
        const code = pattern.exec(content)?.[1];
        if (code && /\d/.test(code)) return { kind: 'code' as const, value: /^\d[\d -]+$/.test(code) ? code.replace(/[ -]/g, '') : code, subject: email.subject };
      }
    }
    if (ask.want !== 'code') {
      const links = email.links.filter(link => {
        try {
          const url = new URL(link.url);
          return url.protocol === 'https:' && !url.username && !url.password
            && !/unsubscribe|privacy|terms|help|support|tracking/i.test(`${link.text} ${url.pathname}`)
            && /verif|confirm|activat|sign.in|log.?in|reset|magic/i.test(`${link.text} ${url.pathname} ${url.searchParams.toString()}`);
        } catch { return false; }
      });
      if (links.length === 1) return { kind: 'link' as const, value: links[0].url, subject: email.subject };
    }
  }
  return null;
}
