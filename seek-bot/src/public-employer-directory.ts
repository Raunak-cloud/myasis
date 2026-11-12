import { careerTarget, employerTargets } from './employer-source-config.js';

export type PublicDirectorySource = 'pageup' | 'smartrecruiters';
export const publicDirectorySources: PublicDirectorySource[] = ['pageup', 'smartrecruiters'];

/** Canonical public employer roots only; application paths and query values never enter the directory. */
export function publicEmployerTarget(source: PublicDirectorySource, raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (source === 'pageup') {
      if (url.hostname !== 'careers.pageuppeople.com' || parts.length < 3) return null;
      return careerTarget('pageup', `${url.origin}/${parts.slice(0, 3).join('/')}`).url.href;
    }
    let company: string;
    if (['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'].includes(url.hostname)) company = parts[0];
    else if (url.hostname === 'api.smartrecruiters.com' && parts[0] === 'v1' && parts[1] === 'companies' && parts[3] === 'postings') company = parts[2];
    else return null;
    if (!company || /^(login|signin|sign-in|apply|candidate|candidatehome|jobs|search|careers)$/i.test(company)) return null;
    return employerTargets('smartrecruiters', company)[0] ?? null;
  } catch { return null; }
}

export function publicDirectoryIdentity(target: string): string { return target.split('|').at(-1)!.toLowerCase(); }
/** Discovered lists are uncapped; the existing manual-list limit is unchanged. */
export function publicEmployerTargets(source: PublicDirectorySource, values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const targets = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      const parts = value.split('|'); if (parts.length > 2) continue;
      const raw = parts.at(-1)!.trim();
      const target = source === 'smartrecruiters' && !raw.includes('://') ? employerTargets(source, raw)[0] : publicEmployerTarget(source, raw);
      if (!target) continue;
      const label = parts.length === 2 ? parts[0].replace(/[,\r\n]/g, ' ').trim().slice(0, 100) : '';
      const entry = source === 'pageup' && label ? `${label}|${target}` : target;
      const identity = publicDirectoryIdentity(target);
      if (!targets.has(identity)) targets.set(identity, entry);
    } catch { /* A malformed public-search result does not remove working employers. */ }
  }
  return [...targets.values()];
}
