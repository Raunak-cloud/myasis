/** Shared board identity for navigation, submission, receipts and saved jobs.
 * Match parsed hostnames on label boundaries, never text in a URL's path. */
export type JobBoard = 'seek' | 'indeed';
const DOMAINS: Readonly<Record<JobBoard, readonly string[]>> = {
  seek: ['seek.com.au', 'seek.com'],
  indeed: ['indeed.com'],
};

export function jobBoardForHost(value: string): JobBoard | null {
  const host = value.toLowerCase().replace(/\.$/, '');
  for (const board of Object.keys(DOMAINS) as JobBoard[]) {
    if (DOMAINS[board].some(domain => host === domain || host.endsWith(`.${domain}`))) return board;
  }
  return null;
}

export function jobBoardForUrl(raw: string): JobBoard | null {
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) ? jobBoardForHost(url.hostname) : null;
  } catch { return null; }
}

/** A board's explicit external-apply handoff still uses employer-site limits. */
export function isExternalApplicationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return !jobBoardForUrl(raw) || /\/apply\/external(?:\/|$)/i.test(url.pathname);
  } catch { return false; } // An unfinished navigation is not an external site.
}
