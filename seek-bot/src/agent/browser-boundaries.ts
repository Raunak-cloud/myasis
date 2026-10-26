import type { Page } from 'patchright';
import { hostOf } from '../site-auth.js';
import { isExternalApplicationUrl, jobBoardForUrl } from '../job-board-url.js';
export const isExternal = isExternalApplicationUrl;

export function listingIdIn(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!jobBoardForUrl(url)) return null;
    const seek = /\/job\/(\d+)/.exec(parsed.pathname)?.[1];
    if (seek) return seek;
    return parsed.searchParams.get('jk') ?? parsed.searchParams.get('vjk');
  } catch {
    return null;
  }
}

/**
 * Destinations the agent is never allowed to drive, whatever it decides.
 *
 * Authentication is handled by a dedicated tool. Payment flows remain outside
 * the application agent.
 */
const FORBIDDEN_URL = /\/(checkout|payment|billing)\b/i;

/**
 * The organisation a host belongs to. Employer ATSs sign candidates in on a
 * sibling host (tafensw-identity.login.pageuppeople.com, then
 * secure.dc2.pageuppeople.com), so account evidence is compared per domain.
 */
export function siteDomain(url: string): string {
  const host = hostOf(url);
  const labels = host.split('.');
  const secondLevel = /^(com|net|org|gov|edu|co|ac)$/.test(labels.at(-2) ?? '') && (labels.at(-1) ?? '').length === 2;
  return labels.slice(secondLevel ? -3 : -2).join('.');
}

export function isForbiddenDestination(url: string): boolean {
  return FORBIDDEN_URL.test(url);
}

export async function detectConfirmation(page: Page): Promise<boolean> {
  // On SEEK, only its dedicated success URL is proof: application forms and
  // employer copy can contain "application received" before anything is sent.
  try {
    const url = new URL(page.url());
    if (jobBoardForUrl(url.href) === 'seek') return /\/apply\/success(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const confirmationCopy =
    /(application (has been|was) (sent|submitted)|your application was sent|nice work,|thanks for applying|application received)/i.test(
      body,
    );
  if (!confirmationCopy) return false;

  // External ATSs share no stable success URL, so their copy is only trusted
  // once the form and every forward action have disappeared.
  const hasForm =
    (await page.locator('form input:visible, form textarea:visible, form select:visible').count().catch(() => 0)) > 0;
  if (hasForm) return false;
  const hasAdvance = await page
    .locator('button:visible, a[role="button"]:visible')
    .filter({ hasText: /continue|next|submit|review/i })
    .count()
    .catch(() => 0);
  return hasAdvance === 0;
}

