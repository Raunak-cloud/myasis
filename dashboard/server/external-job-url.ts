import { resolvesPublic } from './proxy-address.js';

const MAX_URL_LENGTH = 2_048;

/**
 * Validates the one arbitrary destination an operator may hand to a run.
 *
 * This is an outbound browser navigation, so treating an admin as trusted is
 * not enough: a pasted localhost/metadata URL could expose the production
 * network by accident. The bot repeats these checks at the browser boundary;
 * this first pass gives the operator an immediate, useful error.
 */
export async function validateExternalJobUrl(value: unknown): Promise<string | { error: string }> {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Paste the external job URL.' };
  const raw = value.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: 'The external job URL is too long.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'Enter a complete HTTPS job URL.' };
  }
  if (url.protocol !== 'https:') return { error: 'External job URLs must use HTTPS.' };
  if (url.username || url.password) return { error: 'External job URLs cannot contain a username or password.' };
  if (url.port && url.port !== '443') return { error: 'External job URLs cannot use a custom port.' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { error: 'The external job URL must be a public website.' };
  }
  if (host === 'gov.au' || host.endsWith('.gov.au')) {
    return { error: 'Australian government application sites are excluded.' };
  }
  if (/(^|\.)(seek\.com\.au|seek\.com|indeed\.com)$/.test(host)) {
    return { error: 'Use this field for an employer website, not a SEEK or Indeed listing.' };
  }
  if (/\/(?:checkout|payment|billing)(?:\/|$)/i.test(url.pathname)) {
    return { error: 'Use the job page, not a payment page.' };
  }
  if (!(await resolvesPublic(host))) return { error: 'The external job URL must resolve only to public internet addresses.' };

  return url.href;
}
