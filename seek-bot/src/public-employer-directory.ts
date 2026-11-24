import { employerTargets } from './employer-source-config.js';

/** Canonical public Greenhouse board token from a publisher URL. */
export function publicEmployerTarget(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    let board: string | undefined;
    if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname)) {
      if (parts.length === 1 || (parts.length === 3 && parts[1] === 'jobs' && /^\d{1,20}$/.test(parts[2]))) board = parts[0];
    } else if (url.hostname === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards'
      && ((parts.length === 4 && parts[3] === 'jobs') || (parts.length === 5 && parts[3] === 'jobs' && /^\d{1,20}$/.test(parts[4])))) {
      board = parts[2];
    }
    if (!board || /^(embed|login|signin|sign-in|apply|jobs|search|careers)$/i.test(board)) return null;
    return employerTargets('greenhouse', board)[0] ?? null;
  } catch { return null; }
}

/** The shared directory can include more boards than a manual watchlist. */
export function publicEmployerTargets(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const targets = new Map<string, string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    try {
      const target = raw.includes('://') ? publicEmployerTarget(raw) : employerTargets('greenhouse', raw)[0];
      if (target && !targets.has(target.toLowerCase())) targets.set(target.toLowerCase(), target);
    } catch { /* Ignore malformed board entries. */ }
  }
  return [...targets.values()];
}
