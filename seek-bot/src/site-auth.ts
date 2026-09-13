import { createHmac } from 'node:crypto';
import type { CandidateProfile, FormField } from './types.js';

function hostOf(url: string): string {
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
export function sitePassword(url: string, email: string, secret = process.env.SITE_AUTH_SECRET): string | null {
  if (!secret?.trim() || !email.trim()) return null;
  const digest = createHmac('sha256', secret.trim())
    .update(`${email.trim().toLowerCase()}\n${hostOf(url)}`)
    .digest('base64url')
    .replace(/[-_]/g, 'a');
  return `My!${digest.slice(0, 14)}9z`;
}

export function authenticationValue(
  field: FormField,
  profile: CandidateProfile,
  pageUrl: string,
): string | null {
  const label = field.label.toLowerCase();
  const names = profile.name.trim().split(/\s+/).filter(Boolean);
  const firstName = names[0] ?? '';
  const lastName = names.length > 1 ? names[names.length - 1] : '';

  if (field.sensitive || field.inputType === 'password' || /\bpass(word|phrase)\b/.test(label)) {
    return sitePassword(pageUrl, profile.email);
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
