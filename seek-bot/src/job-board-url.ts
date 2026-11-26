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

/** Convert a vacancy link into a stable native posting, dropping referral parameters. */
export function nativeBoardPosting(raw: string): { platform: JobBoard; id: string; url: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const platform = jobBoardForHost(url.hostname);
  if (platform === 'seek') {
    const id = url.pathname.match(/^\/job\/(\d{6,12})(?:\/|$)/i)?.[1]
      ?? url.searchParams.get('jobId');
    if (id && /^\d{6,12}$/.test(id)) return { platform, id, url: `https://www.seek.com.au/job/${id}` };
  } else if (platform === 'indeed') {
    const id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
    if (id && /^[a-f0-9]{16}$/i.test(id)) return { platform, id: id.toLowerCase(), url: `https://au.indeed.com/viewjob?jk=${id.toLowerCase()}` };
  }
  return null;
}

/** A board's explicit external-apply handoff still uses employer-site limits. */
export function isExternalApplicationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return !jobBoardForUrl(raw) || /\/apply\/external(?:\/|$)/i.test(url.pathname);
  } catch { return false; } // An unfinished navigation is not an external site.
}
