import type { VerificationEmail } from './llm.js';
import {isIP} from 'node:net';

// Shared authentication language cannot establish which employer sent a
// message. In particular, "for" in a company name must not match every
// unrelated "a link for your account" email in the mailbox.
const COMMON = new Set('www com net org edu gov co au uk http https sign signin login log secure auth accounts email verification verify code account site the application for your you with and from please this that our password reset link activation confirm careers career jobs apply'.split(' '));
const contextWords = (value: string): string[] => [...new Set(value.toLowerCase().split(/[^a-z0-9]+/)
  .filter(word => word.length > 2 && !COMMON.has(word) && !/^(?:wd|career|jobs|apply)\d+$/.test(word)))];

export function verificationContextWords(ask: { hint?: string; site?: string }): string[] {
  return contextWords(`${ask.site || ''} ${ask.hint || ''}`);
}

const hintAliases = (hint: string) => hint.split(/[/|,;]+/).map(contextWords).filter(words => words.length);

/** The first alias comes from the known employer. A supplementary label made
 * solely from the current hosting domain is transport context, not evidence
 * that a message belongs to that employer. Preserve meaningful sender aliases. */
function employerAliases(ask: { hint?: string; site?: string }): string[][] {
  const site = contextWords(ask.site || '');
  return hintAliases(ask.hint || '').filter((words, index) => index === 0
    || !(words.every(word => site.includes(word)) || site.includes(words.join(''))));
}

/** Sender hints supplement the known employer; a decorated identity-page
 * heading must not replace it with one impossible all-words phrase. Do not
 * promote a hosting platform or generic corporate label to an employer alias. */
export function verificationSenderHint(company: string, jobUrl: string, supplied?: unknown): string {
  const employer = company.trim();
  const hint = typeof supplied === 'string' ? supplied.trim() : '';
  if (!hint || hint.toLowerCase() === employer.toLowerCase()) return employer;
  const generic = new Set(['company', 'corporation', 'group', 'limited', 'ltd', 'inc', 'pty', 'plc']);
  const words = contextWords(employer).filter(word => !generic.has(word));
  // A raw hosting hostname or generic organisation label is not an employer.
  // A real company remains primary even when its job URL is employer-owned;
  // the observed sender hint may name a different, shared authentication host.
  let hostingLabel = false;
  try { hostingLabel = new URL(jobUrl).hostname.toLowerCase() === employer.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''); } catch { /* retain the known employer */ }
  if (!words.length || hostingLabel) return hint;
  return `${employer} | ${hint}`;
}

function matchesContext(content: string, ask: { hint?: string; site?: string }): boolean {
  const contains = (word: string) => new RegExp(`\\b${word}\\b`, 'i').test(content);
  // Site identity and each explicit sender alias are alternative evidence.
  // An alias containing multiple words requires all of them, rather than
  // allowing a generic fragment to select another employer's reset email.
  const site = contextWords(ask.site || '');
  const aliases = employerAliases(ask);
  // A shared ATS hostname fragment must not override a specific employer
  // hint. A hostname can contribute employer identity only when it includes
  // an independently named employer token; hosting words alone are insufficient.
  const siteMatches = site.length > 0 && site.every(contains)
    && (!aliases.length || aliases[0].some(word => site.includes(word)));
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
function linkPurpose(link: { text: string; url: string }): { reset: boolean; activation: boolean; signIn: boolean; explicit: boolean } {
  const url = new URL(link.url);
  const actions = [...url.searchParams].filter(([name]) => /^(?:action|type|mode|purpose|career_ns|login_ns|request)$/i.test(name)).map(([, value]) => value).join(' ');
  const text = `${link.text} ${url.pathname} ${actions}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/.-]/g, ' ');
  return { reset: resetPurpose(text) || /\b(?:reset|passwordreset|pwdreset)\b/i.test(text), activation: activationPurpose(text), signIn: signInPurpose(text),
    explicit: /verif|confirm|activat|sign.in|log.?in|reset|magic|authenticat/i.test(text) };
}

export type VerificationRequest = { hint?: string; site?: string; purpose?: VerificationPurpose };

/** Retain the observed employer tenant, never session tokens or account data. */
export function verificationSiteUrl(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  const tenant = successFactorsTenant(url);
  return tenant ? `https://${url.hostname}/?company=${encodeURIComponent(tenant)}` : url.hostname;
}

function successFactorsTenant(url: URL): string | undefined {
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/^career\d+\.(?:successfactors|sapsf)\.(?:com|eu)$/.test(url.hostname)) return;
  const companies = url.searchParams.getAll('company');
  return companies.length === 1 && /^[a-z0-9_-]{1,100}$/i.test(companies[0]) ? companies[0] : undefined;
}

function tenantDestination(url: URL, ask: VerificationRequest): boolean {
  try {
    const active = new URL(ask.site?.includes('://') ? ask.site : `https://${ask.site || ''}`);
    const tenant = successFactorsTenant(active);
    return Boolean(tenant && url.hostname === active.hostname && successFactorsTenant(url) === tenant);
  } catch { return false; }
}

/** Shared ATS mail may name the employer only in its action's company realm.
 * Require both the actual provider sender and the exact observed tenant/host.
 * Display names, arbitrary query values and a provider hostname alone cannot
 * establish this fallback. */
function matchesTenantRealm(email: LocalVerificationEmail, ask: VerificationRequest): boolean {
  const sender = (email.sender || '').trim().match(/(?:^|<)[^<>\s@]+@((?:[a-z0-9-]+\.)*(?:successfactors|sapsf)\.(?:com|eu))>?$/i)?.[1].toLowerCase();
  if (!sender) return false;
  return email.links.some(link => {
    try {
      const url = new URL(link.url);
      return tenantDestination(url, ask) && (url.hostname === sender || url.hostname.endsWith(`.${sender}`));
    } catch { return false; }
  });
}

/** An explicitly named multiword identity provider may spell its brand as one
 * DNS label. Accept that spelling only from the actual sender address, with the
 * current authentication host inside that sender's exact DNS realm. Display
 * names, body mentions and tracking URLs cannot establish this fallback. */
function matchesSenderDomainAlias(email: LocalVerificationEmail, ask: VerificationRequest): boolean {
  // A named provider can establish the selected sign-in realm. With a distinct
  // employer context, it cannot by itself identify whose registration/reset
  // message this is on a multi-tenant ATS. Those flows need employer evidence.
  if ((ask.purpose === 'account_verification' || ask.purpose === 'reset_password')
    && hintAliases(ask.hint || '').length > 1) return false;
  try {
    const site = new URL(ask.site?.includes('://') ? ask.site : `https://${ask.site || ''}`);
    if (site.username || site.password) return false;
    const address = (email.sender || '').trim().match(/(?:^|<)[^<>\s@]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)>?$/i);
    const domain = address?.[1].toLowerCase();
    if (!domain || domain.split('.').length < 2 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
    const host = site.hostname.toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) return false;
    const labels = new Set(domain.split('.'));
    return (ask.hint || '').split(/[/|,;]+/).map(contextWords)
      .some(words => words.length > 1 && labels.has(words.join('')));
  } catch { return false; }
}

function requestedLinkInstruction(text: string, purpose: VerificationPurpose | undefined): boolean {
  const normalized = text.replace(/\s+/g, ' ');
  const qualifier = '(?:(?:your|the)\\s+)?(?:[\\p{L}\\p{N}&\u2019\'.-]+\\s+){0,5}';
  if (purpose === 'account_verification') return new RegExp(`\\b(?:activate|verify|confirm)\\s+${qualifier}(?:email|account|registration|identity)\\b|\\b(?:activation|verification|confirmation)\\s+link\\b`, 'iu').test(normalized);
  if (purpose === 'reset_password') return resetPurpose(normalized)
    && new RegExp(`\\b(?:reset|recover)\\s+${qualifier}(?:password|credentials?)\\b|\\bpassword[ -]reset\\s+link\\b`, 'iu').test(normalized);
  return false;
}

function trustedOpaqueDestination(url: URL, email: LocalVerificationEmail, ask: VerificationRequest): boolean {
  const hosts: string[] = [];
  try {
    if (ask.site) {
      const active = new URL(ask.site.includes('://') ? ask.site : `https://${ask.site}`);
      if (!active.username && !active.password) hosts.push(active.hostname.toLowerCase());
    }
  } catch { /* An invalid current host cannot authorize an opaque destination. */ }
  const sender = (email.sender || '').trim().match(/(?:^|<)[^<>\s@]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)>?$/i)?.[1].toLowerCase();
  if (sender && sender.includes('.') && matchesContext(sender,
    { hint: employerAliases(ask).map(words => words.join(' ')).join(' | ') })) hosts.push(sender);
  return hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export type VerificationEmailMatchReason = 'matched' | 'context-missing' | 'identity-unproven' | 'purpose-mismatch' | 'purpose-unproven' | 'auth-language-unproven';
export interface VerificationEmailMatchDecision {
  matched: boolean;
  reason: VerificationEmailMatchReason;
  /** Only abstract decisions leave this helper. Skipped gates are omitted,
   * rather than reported as false or revealing unrelated message purposes. */
  checks: { contextPresent: boolean; identityMatched?: boolean; providerRealmMatched?: boolean;
    tenantRealmMatched?: boolean; requestedPurposeCompatible?: boolean; authenticationLanguageRecognized?: boolean };
}

/** One decision drives both acceptance and private diagnostics; there is no
 * second regex implementation that could disagree or relax mailbox safety. */
export function verificationEmailMatchDecision(email: LocalVerificationEmail, ask: VerificationRequest): VerificationEmailMatchDecision {
  const checks: VerificationEmailMatchDecision['checks'] = { contextPresent: verificationContextWords(ask).length > 0 };
  const finish = (reason: VerificationEmailMatchReason): VerificationEmailMatchDecision => ({ matched: reason === 'matched', reason, checks });
  if (!checks.contextPresent) return finish('context-missing');
  const content = `${email.subject}\n${email.text}`;
  // Tracking query strings can mention a company without identifying the
  // sender or destination. Use hosts, never arbitrary URL parameters.
  const hosts = email.links.flatMap(link => { try { return [new URL(link.url).hostname]; } catch { return []; } });
  const identity = `${email.sender || ''}\n${content}\n${hosts.join('\n')}`;
  checks.identityMatched = matchesContext(identity, ask);
  checks.providerRealmMatched = matchesSenderDomainAlias(email, ask);
  checks.tenantRealmMatched = matchesTenantRealm(email, ask);
  if (!checks.identityMatched && !checks.providerRealmMatched && !checks.tenantRealmMatched) return finish('identity-unproven');
  const resetMail = resetPurpose(email.subject) || (!activationPurpose(email.subject) && !signInPurpose(email.subject) && resetPurpose(email.text));
  const activationMail = activationPurpose(email.subject);
  checks.requestedPurposeCompatible = false;
  if (ask.purpose && ask.purpose !== 'reset_password' && resetMail) return finish('purpose-mismatch');
  if (ask.purpose === 'sign_in' && activationMail) return finish('purpose-mismatch');
  if (ask.purpose === 'reset_password' && !resetMail) return finish(activationMail || signInPurpose(email.subject) ? 'purpose-mismatch' : 'purpose-unproven');
  checks.requestedPurposeCompatible = true;
  // Purpose recognition is authoritative for authentication language too.
  // Requiring a second, differently worded reset regex here rejects genuine
  // "Password Reset" messages despite recognizing their requested purpose.
  checks.authenticationLanguageRecognized = resetMail || activationMail || signInPurpose(email.subject)
    || /verif|pass[ -]?code|one.time|security code|sign[ .-]?in|log[ .-]?in|\bOTP\b|authentication|access code|activat|confirm/i.test(content);
  return finish(checks.authenticationLanguageRecognized ? 'matched' : 'auth-language-unproven');
}

/** The same identity/purpose test drives extraction and missing-format diagnostics. */
export function isRequestedVerificationEmail(email: LocalVerificationEmail, ask: VerificationRequest): boolean {
  return verificationEmailMatchDecision(email, ask).matched;
}

/** Shared hard vetoes. Model interpretation can never override these. */
function verificationLinkSafe(link: LocalVerificationEmail['links'][number], ask: VerificationRequest): boolean {
  try {
    const url = new URL(link.url);
    let tenantScoped = false;
    try { tenantScoped = Boolean(successFactorsTenant(new URL(ask.site?.includes('://') ? ask.site : `https://${ask.site || ''}`))); } catch { /* no tenant context */ }
    if (tenantScoped && !tenantDestination(url, ask)) return false;
    const purpose = linkPurpose(link);
    if (ask.purpose) {
      if (ask.purpose === 'reset_password' && (purpose.activation && !purpose.reset || purpose.signIn && !purpose.reset)) return false;
      if (ask.purpose !== 'reset_password' && purpose.reset) return false;
      if (ask.purpose === 'sign_in' && purpose.activation) return false;
    }
    return url.protocol === 'https:' && !url.username && !url.password
      && !/unsubscribe|privacy|terms|help|support|tracking/i.test(`${link.text} ${url.pathname}`);
  } catch { return false; }
}

/** AI may interpret unusual labels, but only on a matching authentication
 * message and an observed employer/provider destination. Never send URLs to AI. */
export function verificationFallbackLinks(email: LocalVerificationEmail, ask: VerificationRequest) {
  if (!isRequestedVerificationEmail(email, ask)) return [];
  const links = email.links.filter(link => {
    if (!verificationLinkSafe(link, ask)) return false;
    const url = new URL(link.url);
    const action=[...url.searchParams].filter(([k])=>/^(?:action|type|mode|purpose|request)$/i.test(k)).map(([,v])=>v).join(' ');
    const destructive=/\b(?:delete|remove|revoke|logout|signout|unsubscribe|billing|payment|preferences)\b/i.test(`${link.text} ${url.pathname.replace(/[_/.-]/g,' ')} ${action}`);
    return !url.port && !isIP(url.hostname.replace(/^\[|\]$/g,'')) && url.hostname.includes('.')
      && !/\.(?:local|internal)$/i.test(url.hostname) && !destructive && url.pathname !== '/' && trustedOpaqueDestination(url, email, ask);
  });
  return [...new Map(links.map(link => [link.url, link])).values()];
}

/** Parse untrusted mailbox text as data. No prompts or mailbox bodies go to an AI service. */
export function readVerificationEmailsLocally(emails: LocalVerificationEmail[], ask: VerificationRequest & { want: 'code' | 'link' | 'either' }) {
  for (const email of emails) {
    if (!isRequestedVerificationEmail(email, ask)) continue;
    const content = `${email.subject}\n${email.text}`;
    if (ask.want !== 'link') {
      const token = '(\\d{4}[ -]\\d{4}|\\d{3}[ -]\\d{3}|[A-Z0-9]{4,12}(?:-[A-Z0-9]{3,6})?)';
      const label = '(?:verification|security|sign[ .-]?in|log[ .-]?in|one.time|confirmation|access|authentication)';
      // A linking word and punctuation are independent: real messages use
      // "is: CODE", table/newline separators and typographic dashes. Keep
      // extraction adjacent to a code label rather than scanning for digits.
      const separator = '\\s*(?:is\\b\\s*)?[:=\\-\u2013\u2014]?\\s*';
      const patterns = [
        new RegExp(`\\b(?:${label}\\s+(?:code|pass[ -]?code|PIN)|pass[ -]?code|OTP)${separator}${token}\\b`, 'gi'),
        new RegExp(`\\b${token}\\b\\s+(?:is\\s+(?:your|the)\\s+)?${label}\\s+code\\b`, 'gi'),
        new RegExp(`\\b(?:use|enter)\\s+${token}\\s+to\\s+(?:verify|confirm|sign.in|log.in)\\b`, 'gi'),
        new RegExp(`\\b(?:code|PIN)${separator}${token}\\b`, 'gi'),
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
      // An opaque URL cannot supply its own identity or purpose. Require both
      // from visible mail, independent of provider-DNS and link-host fallbacks.
      const opaqueInstruction = requestedLinkInstruction(email.text, ask.purpose)
        && matchesContext(`${email.sender || ''}\n${content}`, { hint: employerAliases(ask).map(words => words.join(' ')).join(' | ') });
      if (!authenticationSubject && !authenticationInstruction) continue;
      const candidates = email.links.flatMap(link => {
        try {
          const url = new URL(link.url);
          if (!verificationLinkSafe(link, ask)) return [];
          const purpose = linkPurpose(link);
          return purpose.explicit || opaqueInstruction && trustedOpaqueDestination(url, email, ask)
            ? [{ link, explicit: purpose.explicit }] : [];
        } catch { return []; }
      });
      // Opaque authentication destinations are a fallback, not peers of an explicit
      // action. A harmless employer/footer link must not make the real reset
      // action ambiguous. Two explicit actions still require disambiguation.
      const explicit = candidates.filter(candidate => candidate.explicit);
      const links = (explicit.length ? explicit : candidates).map(candidate => candidate.link);
      const unique = [...new Map(links.map(link => [new URL(link.url).href, link])).values()];
      if (unique.length === 1) return { kind: 'link' as const, value: unique[0].url, subject: email.subject };
    }
  }
  return null;
}
