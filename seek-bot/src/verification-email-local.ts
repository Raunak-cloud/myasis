import type { VerificationEmail } from './llm.js';

// Shared authentication language cannot establish which employer sent a
// message. In particular, "for" in a company name must not match every
// unrelated "a link for your account" email in the mailbox.
const COMMON = new Set('www com net org edu gov co au uk http https sign signin login log secure auth accounts email verification verify code account site the application for your you with and from please this that our password reset link activation confirm careers career jobs apply'.split(' '));
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
  // A shared ATS hostname fragment must not override a specific employer
  // hint. Host identity needs all of its meaningful words; a bare platform
  // name is sufficient only when the caller also named it as a sender alias.
  const siteMatches = site.length > 0 && site.every(contains)
    && (!aliases.length || site.length > 1 || aliases.some(words => words.includes(site[0])));
  return siteMatches || aliases.some(words => words.every(contains));
}

export type LocalVerificationEmail = VerificationEmail & { sender?: string };
export const VERIFICATION_PURPOSES = ['account_verification', 'sign_in', 'reset_password'] as const;
export type VerificationPurpose = typeof VERIFICATION_PURPOSES[number];
const resetPurpose = (text: string) => /\b(?:reset|recover|forgot(?:ten)?)\b.{0,40}\b(?:password|credentials?)\b|\bpassword\b.{0,25}\b(?:reset|recovery)\b|\b(?:reset|recover)[_-]?(?:password|pwd)\b/i.test(text.replace(/\s+/g, ' '));
const activationPurpose = (text: string) => /\bactivat(?:e|ion|ing)\b/i.test(text);
const signInPurpose = (text: string) => /\bsign[ _.-]?in\b|\blog[ _.-]?in\b|\bmagic[ _-]?link\b/i.test(text);

/** Private mail purpose is part of the requested operation, not just sender
 * identity. Ignore opaque token/query values when interpreting a link. */
function linkPurpose(link: { text: string; url: string }): { reset: boolean; activation: boolean; signIn: boolean } {
  const url = new URL(link.url);
  const actions = [...url.searchParams].filter(([name]) => /^(?:action|type|mode|purpose|career_ns|login_ns|request)$/i.test(name)).map(([, value]) => value).join(' ');
  const text = `${link.text} ${url.pathname} ${actions}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/.-]/g, ' ');
  return { reset: resetPurpose(text) || /\breset\b/i.test(text), activation: activationPurpose(text), signIn: signInPurpose(text) };
}

/** Parse untrusted mailbox text as data. No prompts or mailbox bodies go to an AI service. */
export function readVerificationEmailsLocally(emails: LocalVerificationEmail[], ask: { hint?: string; site?: string; want: 'code' | 'link' | 'either'; purpose?: VerificationPurpose }) {
  const words = verificationContextWords(ask);
  if (!words.length) return null;
  for (const email of emails) {
    const content = `${email.subject}\n${email.text}`;
    // Tracking query strings can mention a company without identifying the
    // sender or destination. Use hosts, never arbitrary URL parameters.
    const hosts = email.links.flatMap(link => { try { return [new URL(link.url).hostname]; } catch { return []; } });
    const identity = `${email.sender || ''}\n${content}\n${hosts.join('\n')}`;
    if (!matchesContext(identity, ask)) continue;
    const resetMail = resetPurpose(email.subject) || (!activationPurpose(email.subject) && !signInPurpose(email.subject) && resetPurpose(email.text));
    const activationMail = activationPurpose(email.subject);
    if (ask.purpose && ask.purpose !== 'reset_password' && resetMail) continue;
    if (ask.purpose === 'sign_in' && activationMail) continue;
    if (ask.purpose === 'reset_password' && !resetMail) continue;
    if (!/verif|pass[ -]?code|one.time|security code|sign[ .-]?in|log[ .-]?in|\bOTP\b|authentication|access code|activat|confirm|reset.*password/i.test(content)) continue;
    if (ask.want !== 'link') {
      const token = '(\\d{4}[ -]\\d{4}|\\d{3}[ -]\\d{3}|[A-Z0-9]{4,12}(?:-[A-Z0-9]{3,6})?)';
      const label = '(?:verification|security|sign[ .-]?in|log[ .-]?in|one.time|confirmation|access|authentication)';
      const patterns = [
        new RegExp(`\\b(?:${label}\\s+(?:code|pass[ -]?code|PIN)|pass[ -]?code|OTP)\\s*(?:is\\b|:|=|-)?\\s*${token}\\b`, 'gi'),
        new RegExp(`\\b${token}\\b\\s+(?:is\\s+(?:your|the)\\s+)?${label}\\s+code\\b`, 'gi'),
        new RegExp(`\\b(?:use|enter)\\s+${token}\\s+to\\s+(?:verify|confirm|sign.in|log.in)\\b`, 'gi'),
        new RegExp(`\\b(?:code|PIN)\\s*(?:is\\b|:|=|-)?\\s*${token}\\b`, 'gi'),
      ];
      for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
          const code = match[1];
          if (code && /\d/.test(code)) return { kind: 'code' as const, value: /^\d[\d -]+$/.test(code) ? code.replace(/[ -]/g, '') : code, subject: email.subject };
        }
      }
    }
    if (ask.want !== 'code') {
      // Newsletters can mention the requested employer and contain a generic
      // "Sign in" footer. That does not make the message an authentication
      // email. Require authentication purpose before considering its links.
      const authenticationSubject = /\b(?:verify|verification|confirm|confirmation|activat\w*|password|passcode|one.time|sign[ .-]?in|log[ .-]?in|magic link)\b/i.test(email.subject);
      const authenticationInstruction = /\b(?:verify|confirm|activate)\s+(?:your\s+)?(?:email|account|registration|identity)\b|\breset\s+(?:your\s+)?password\b|\b(?:one.time|magic|verification|activation|password.reset)\s+link\b/i.test(email.text);
      const opaqueResetLink = ask.purpose === 'reset_password' && resetMail && /\breset\s+(?:(?:your|the)\s+)?password\b|\bpassword[ -]reset\s+link\b/i.test(email.text);
      if (!authenticationSubject && !authenticationInstruction) continue;
      const links = email.links.filter(link => {
        try {
          const url = new URL(link.url);
          if (ask.purpose) {
            const purpose = linkPurpose(link);
            if (ask.purpose === 'reset_password' && (purpose.activation && !purpose.reset || purpose.signIn && !purpose.reset)) return false;
            if (ask.purpose !== 'reset_password' && purpose.reset) return false;
            if (ask.purpose === 'sign_in' && purpose.activation) return false;
          }
          return url.protocol === 'https:' && !url.username && !url.password
            && !/unsubscribe|privacy|terms|help|support|tracking/i.test(`${link.text} ${url.pathname}`)
            && (opaqueResetLink || /verif|confirm|activat|sign.in|log.?in|reset|magic|authenticat/i.test(`${link.text} ${url.pathname} ${url.searchParams.toString()}`));
        } catch { return false; }
      });
      const unique = [...new Map(links.map(link => [new URL(link.url).href, link])).values()];
      if (unique.length === 1) return { kind: 'link' as const, value: unique[0].url, subject: email.subject };
    }
  }
  return null;
}
