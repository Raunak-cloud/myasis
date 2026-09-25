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
 * A government application address the board itself gave for this listing.
 * Policy, decided by the address alone, before any model sees the listing.
 */
export function australianGovernmentDestination(job: JobListing): string | null {
  for (const value of [job.applicationUrl, job.url]) {
    if (isAustralianGovernmentUrl(value)) return value!;
  }
  return null;
}

/** Government addresses written into the ad's text, which may or may not be where it is applied for. */
function governmentAddressesInText(job: JobListing): string[] {
  const text = [job.description, job.teaser].filter(Boolean).join(' ');
  return (text.match(/(?:https?:\/\/|www\.)[^\s<>"')]+/gi) ?? [])
    .map((raw) => (/^www\./i.test(raw) ? `https://${raw}` : raw))
    .filter((candidate) => isAustralianGovernmentUrl(candidate));
}

/**
 * Where a listing's application actually goes, when that is a government site.
 * The board's own addresses decide outright; an address only mentioned in the
 * ad (an award rate, a visa page) is judged by the model, since citing a
 * government page does not make the application a government one.
 */
export async function governmentApplicationRoute(
  job: JobListing,
  appliesThere: (job: JobListing, addresses: string[]) => Promise<boolean>,
): Promise<string | null> {
  const direct = australianGovernmentDestination(job);
  if (direct) return direct;
  const mentioned = governmentAddressesInText(job);
  if (!mentioned.length) return null;
  // Unsure means excluded: the policy errs towards not applying.
  return (await appliesThere(job, mentioned).catch(() => true)) ? mentioned[0] : null;
}
