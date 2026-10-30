import type { VerificationEmail } from './llm.js';

// Shared authentication language cannot establish which employer sent a
// message. In particular, "for" in a company name must not match every
// unrelated "a link for your account" email in the mailbox.
const COMMON = new Set('www com net org edu gov co au uk http https sign signin login log email verification verify code account site the application for your you with and from please this that our password reset link activation confirm careers career jobs apply'.split(' '));
const contextWords = (value: string): string[] => [...new Set(value.toLowerCase().split(/[^a-z0-9]+/)
  .filter(word => word.length > 2 && !COMMON.has(word) && !/^(?:wd|career|jobs|apply)\d+$/.test(word)))];

export function verificationContextWords(ask: { hint?: string; site?: string }): string[] {
  return contextWords(`${ask.site || ''} ${ask.hint || ''}`);
}

function matchesContext(content: string, ask: { hint?: string; site?: string }): boolean {
  const contains = (word: string) => new RegExp(`\\b${word}\\b`, 'i').test(content);
  // Site identity and each explicit sender alias are alternative evidence.
  // An alias containing multiple words requires all of them, rather than
  // allowing a generic fragment to select another employer's reset email.
  const site = contextWords(ask.site || '');
  const aliases = (ask.hint || '').split(/[/|,;]+/).map(contextWords).filter(words => words.length);
  return site.some(contains) || aliases.some(words => words.every(contains));
}

/** Parse untrusted mailbox text as data. No prompts or mailbox bodies go to an AI service. */
export function readVerificationEmailsLocally(emails: VerificationEmail[], ask: { hint?: string; site?: string; want: 'code' | 'link' | 'either' }) {
  const words = verificationContextWords(ask);
  if (!words.length) return null;
  for (const email of emails) {
    const content = `${email.subject}\n${email.text}`;
    const identity = `${content}\n${email.links.map(link => link.url).join('\n')}`;
    if (!matchesContext(identity, ask)) continue;
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
      // Newsletters can mention the requested employer and contain a generic
      // "Sign in" footer. That does not make the message an authentication
      // email. Require authentication purpose before considering its links.
      const authenticationSubject = /\b(?:verify|verification|confirm|confirmation|activat\w*|password|passcode|one.time|sign.in|log.in|magic link)\b/i.test(email.subject);
      const authenticationInstruction = /\b(?:verify|confirm|activate)\s+(?:your\s+)?(?:email|account|registration|identity)\b|\breset\s+(?:your\s+)?password\b|\b(?:one.time|magic|verification|activation|password.reset)\s+link\b/i.test(email.text);
      if (!authenticationSubject && !authenticationInstruction) continue;
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
