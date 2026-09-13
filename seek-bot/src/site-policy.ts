import type { JobListing } from './types.js';

/** Australian government sites are excluded from every review and apply path. */
export function isAustralianGovernmentUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'gov.au' || host.endsWith('.gov.au');
  } catch {
    return false;
  }
}

/**
 * Finds a government destination using only listing data already collected by
 * the board adapter. This runs before any model sees the listing.
 */
export function australianGovernmentDestination(job: JobListing): string | null {
  for (const value of [job.applicationUrl, job.url]) {
    if (isAustralianGovernmentUrl(value)) return value!;
  }

  const text = [job.description, job.teaser].filter(Boolean).join(' ');
  const matches = text.match(/(?:https?:\/\/|www\.)[^\s<>"')]+/gi) ?? [];
  for (const raw of matches) {
    const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
    if (isAustralianGovernmentUrl(candidate)) return candidate;
  }
  return null;
}
