/** Public identity of an employer login, never a password or a job-board identity. */
import { jobBoardForHost } from './job-board-url.js';
export const employerName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
export function employerAccountSite(url: string, employer = ''): string {
  const parsed = new URL(url.includes('://') ? url : `https://${url}`);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if(jobBoardForHost(host))return host;
  // SuccessFactors explicitly identifies its independent employer tenants by company.
  const company = /(?:^|\.)successfactors\.(?:com|eu)$/.test(host) ? parsed.searchParams.get('company') : null;
  if (company?.trim()) return `${host}/?company=${encodeURIComponent(company.trim())}`;
  const name = employerName(employer) || parsed.searchParams.get('owtomate_employer');
  return name ? `${host}/?owtomate_employer=${encodeURIComponent(name)}` : host;
}
export function sharedEmployerHost(url: string): boolean {
  const host = new URL(url.includes('://') ? url : `https://${url}`).hostname;
  return /(?:^|\.)(?:successfactors\.(?:com|eu)|taleo\.net|smartrecruiters\.com|myworkdayjobs\.com)$/.test(host);
}
export interface AccountAccess {
  version: 1;
  kind: 'existing-account';
  site: string;
}
export function accountAccess(value: unknown): AccountAccess | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.kind !== 'existing-account' || typeof v.site !== 'string' || v.site.length > 1000) return null;
  try {
    const url = new URL(`https://${v.site}`);
    if (!url.hostname || url.username || url.password || url.port || url.hash || employerAccountSite(url.href) !== v.site) return null;
  } catch { return null; }
  return { version: 1, kind: 'existing-account', site: v.site };
}
export const accountAccessMessage = 'An account already exists with your email, but Owtomate has no saved login for this employer. Open your Owtomate browser, sign in to that account, then retry this application.';
