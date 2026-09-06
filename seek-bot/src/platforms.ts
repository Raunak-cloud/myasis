/**
 * Which job boards this tool can drive.
 *
 * Discovery and the apply flow are board-specific — Seek's listings come out of
 * its Apollo cache and its Quick Apply is a multi-step React form, none of
 * which transfers to another site. So a platform is only "available" once it
 * has a real adapter, and the UI says so rather than offering a switch that
 * silently does nothing.
 */
export type PlatformId = 'seek' | 'indeed' | 'jora';

export interface Platform {
  id: PlatformId;
  label: string;
  baseUrl: string;
  available: boolean;
  /** Shown in the UI when a platform cannot be selected yet. */
  note?: string;
}

export const PLATFORMS: Platform[] = [
  {
    id: 'seek',
    label: 'SEEK',
    baseUrl: 'https://www.seek.com.au',
    available: true,
  },
  {
    id: 'indeed',
    label: 'Indeed',
    baseUrl: 'https://au.indeed.com',
    available: true,
    note: 'Indeed puts reCAPTCHA on every Easy Apply step (invisible v3-style, not usually a visible wall) — a run backs off automatically if a visible challenge ever appears.',
  },
  {
    id: 'jora',
    label: 'Jora',
    baseUrl: 'https://au.jora.com',
    available: false,
    note: 'Aggregator — its listings mirror SEEK and Indeed and almost always hand off to the original site, so there is little here to automate.',
  },
];

export function getPlatform(id: string): Platform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

/**
 * Resolves the configured list, dropping anything without an adapter so a
 * stale setting can never point a run at a board it cannot drive.
 */
export function enabledPlatforms(configured: string): Platform[] {
  const wanted = configured
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const chosen = PLATFORMS.filter((p) => p.available && wanted.includes(p.id));
  return chosen.length ? chosen : PLATFORMS.filter((p) => p.id === 'seek');
}
