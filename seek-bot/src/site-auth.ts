import { createHmac } from 'node:crypto';
import type { CandidateProfile, FormField } from './types.js';
import { PASSWORD_WORDS } from './password-words.js';

/** The site a credential belongs to. Shared with the dashboard, which derives the same password on request. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'external-site';
  }
}

/**
 * A stable, unique password for one candidate on one site. Nothing is stored
 * in the answer bank or logs, and one site's credential cannot be reused on
 * another. The deployment secret is required so the value cannot be derived
 * from public profile data.
 */
export function sitePassword(url: string, email: string, secret = process.env.SITE_AUTH_SECRET, credential?: SiteCredential | null): string | null {
  if (!secret?.trim() || !email.trim()) return null;
  if (credential?.format === 'readable-v1') return readablePassword(url, email, secret.trim(), credential.rules ?? {});
  const digest = createHmac('sha256', secret.trim())
    .update(`${email.trim().toLowerCase()}\n${hostOf(url)}`)
    .digest('base64url')
    .replace(/[-_]/g, 'a');
  return `My!${digest.slice(0, 14)}9z`;
}

/**
 * The site's own password rules, as the agent read them off the page: its
 * stated requirements, or the message a rejected password came back with.
 */
export interface PasswordRules {
  max_length?: number;
  min_length?: number;
  /** Whether the site requires, allows or forbids special characters. */
  symbols?: 'required' | 'allowed' | 'not_allowed';
  /** The special characters it accepts, when it lists them. */
  allowed_symbols?: string;
}

/**
 * How a site account's password was made, recorded when Owtomate created or
 * reset it. Nothing secret: the password is derived again from the deployment
 * secret, so the same record lets the dashboard show it to its owner.
 * Accounts with no record keep the original password formula.
 */
export interface SiteCredential {
  format: 'readable-v1';
  rules?: PasswordRules;
}

const SYMBOLS = '!@#$%&*?+=.';

/** Only rules that make sense; anything else falls back to the defaults. */
export function normalizeRules(input: unknown): PasswordRules {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const int = (value: unknown, low: number, high: number) => {
    const n = Math.round(Number(value));
    return value !== undefined && value !== null && Number.isFinite(n) && n >= low && n <= high ? n : undefined;
  };
  const rules: PasswordRules = {};
  const max = int(raw.max_length, 8, 128);
  const min = int(raw.min_length, 1, 128);
  if (max) rules.max_length = max;
  if (min && (!max || min <= max)) rules.min_length = min;
  if (raw.symbols === 'required' || raw.symbols === 'allowed' || raw.symbols === 'not_allowed') rules.symbols = raw.symbols;
  if (typeof raw.allowed_symbols === 'string') {
    const listed = [...new Set([...raw.allowed_symbols].filter((c) => /[^A-Za-z0-9\s]/.test(c)))].join('');
    if (listed) rules.allowed_symbols = listed;
  }
  return rules;
}

/**
 * A password a person can read and type: capitalised simple words, three
 * digits and a symbol, e.g. "MapleRiverStone472!". Built to the site's own
 * rules, so a length cap or a banned character no longer blocks an account.
 * Still unique per site and person and derived from the deployment secret:
 * the model reads the rules, but never chooses or sees the password.
 */
function readablePassword(url: string, email: string, secret: string, rules: PasswordRules): string {
  const bytes = createHmac('sha512', secret).update(`${email.trim().toLowerCase()}\n${hostOf(url)}\nreadable-v1`).digest();
  let at = 0;
  const next = () => {
    const value = (bytes[at % bytes.length] << 8) | bytes[(at + 1) % bytes.length];
    at += 2;
    return value;
  };
  const max = rules.max_length ?? 24;
  const min = Math.min(rules.min_length ?? 12, max);
  const pool = [...(rules.allowed_symbols ?? SYMBOLS)];
  const symbol = rules.symbols === 'not_allowed' ? '' : pool[next() % pool.length];
  const suffix = String(next() % 1000).padStart(3, '0') + symbol;
  const cap = (word: string) => word[0].toUpperCase() + word.slice(1);

  let body = '';
  for (let words = 0; words < 4; words += 1) {
    const word = cap(PASSWORD_WORDS[next() % PASSWORD_WORDS.length]);
    if (body.length + word.length + suffix.length > max) break;
    body += word;
  }
  // Too tight for even two short words: letters from the same digest, mixed case.
  if (body.length < 6) {
    const letters = bytes.toString('base64').replace(/[^a-z]/g, '');
    const room = Math.max(2, max - suffix.length);
    body = letters.slice(0, room);
    body = body[0].toUpperCase() + body.slice(1, -1) + body.slice(-1).toUpperCase();
  }
  // Short of a minimum: more digits, before the symbol.
  let digits = suffix.slice(0, 3);
  while (body.length + digits.length + symbol.length < min) digits += String(next() % 10);
  return (body + digits + symbol).slice(0, max);
}

export function authenticationValue(
  field: FormField,
  profile: CandidateProfile,
  pageUrl: string,
  credential?: SiteCredential | null,
): string | null {
  const label = field.label.toLowerCase();
  const names = profile.name.trim().split(/\s+/).filter(Boolean);
  const firstName = names[0] ?? '';
  const lastName = names.length > 1 ? names[names.length - 1] : '';

  if (field.sensitive || field.inputType === 'password' || /\bpass(word|phrase)\b/.test(label)) {
    return sitePassword(pageUrl, profile.email, undefined, credential);
  }
  if (field.inputType === 'email' || /\b(e-?mail|email address|login id|user ?name)\b/.test(label)) {
    return profile.email || null;
  }
  if (/\bfirst name\b|\bgiven name\b/.test(label)) return firstName || null;
  if (/\blast name\b|\bsurname\b|\bfamily name\b/.test(label)) return lastName || null;
  if (/\bfull name\b|\byour name\b|^name\b/.test(label)) return profile.name || null;
  if (field.inputType === 'tel' || /\b(phone|mobile)\b/.test(label)) return profile.phone || null;
  return null;
}
