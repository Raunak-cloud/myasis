import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { hostOf, type SiteCredential } from './site-auth.js';
import type { ApplicationAction } from './types.js';

/**
 * How each employer-site account's password was made: its format and the
 * site's rules, never the password. Kept with the account's data so a later
 * run signs in with the same password and the dashboard can show it.
 */
const FILE = () => resolve(config.dataDir, 'site-credentials.json');
const key = (url: string, email: string) => `${hostOf(url)}|${email.trim().toLowerCase()}`;

type CredentialRecord = Partial<SiteCredential> & { at?: string; status?: 'accepted' | 'rejected' };
function readAll(): Record<string, CredentialRecord> {
  try {
    return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : {};
  } catch {
    return {};
  }
}

export function storedCredential(url: string, email: string): SiteCredential | null {
  const record = readAll()[key(url, email)];
  if (!record || (record.status !== undefined && record.status !== 'accepted') || record.format !== 'readable-v1') return null;
  return { format: record.format, ...(record.rules ? { rules: record.rules } : {}) };
}

/** Rejected passwords remain unavailable in subsequent attempts and runs.
 * No password bytes, derived passwords or candidate answers are stored. */
export function rejectCredential(url: string, email: string): void {
  const all = readAll(), id = key(url, email);
  all[id] = { ...all[id], status: 'rejected', at: new Date().toISOString() };
  writeFileSync(FILE(), JSON.stringify(all, null, 2));
}

function rememberCredential(url: string, email: string, credential: SiteCredential): void {
  const all = readAll();
  all[key(url, email)] = { ...credential, status: 'accepted', at: new Date().toISOString() };
  writeFileSync(FILE(), JSON.stringify(all, null, 2));
}

/**
 * Remembers each password set in an attempt whose site accepted it: the
 * account was created, or a new password was explicitly accepted after reset. A password
 * the site never accepted (a sign-up refused because the account exists) is
 * dropped, and the account keeps the password it has.
 */
export function commitAcceptedCredentials(
  pending: Map<string, SiteCredential> | undefined,
  actions: ApplicationAction[],
  email: string,
): void {
  for (const [site, credential] of pending ?? []) {
    const accepted = actions.some((known) => (known.kind === 'account-created' || known.kind === 'password-reset')
      && hostOf(`https://${known.site}`) === site && known.email?.trim().toLowerCase() === email.trim().toLowerCase());
    if (accepted) {
      rememberCredential(`https://${site}`, email, credential);
      pending?.delete(site);
    }
  }
}
