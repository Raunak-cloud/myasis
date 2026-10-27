import type { JobListing } from './types.js';

/** Relative board dates, keeping months distinct from minute abbreviations. */
export function parseAgeDays(text?: string): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const m = t.match(/\b(\d+)\s*(\+)?\s*(years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)\b\s*(\+)?/);
  if (!m) {
    if (/\byesterday\b/.test(t)) return 1;
    return /\b(?:just now|today)\b/.test(t) ? 0 : undefined;
  }
  const unit = m[3];
  const amount = Number(m[1]);
  if (/^h/.test(unit)) return Math.floor(amount / 24);
  if (/^(?:m$|min)/.test(unit)) return Math.floor(amount / 1440);
  const multiplier = /^y/.test(unit) ? 365 : /^mo/.test(unit) ? 30 : /^w/.test(unit) ? 7 : 1;
  // "30+ days" and "over 30 days" are older than a 30-day maximum,
  // rather than an unknown age that slips past the deterministic filter.
  const olderThan = m[2] || m[4] || /\b(?:over|more than)\s*$/.test(t.slice(0, m.index));
  return amount * multiplier + (olderThan ? 1 : 0);
}

/** Publication evidence only; an edit timestamp never establishes listing age. */
export function listingAgeDays(job: Pick<JobListing, 'ageDays' | 'listedAt'>, now = Date.now()): number | undefined {
  if (job.listedAt && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(job.listedAt)) {
    const published = Date.parse(job.listedAt);
    if (Number.isFinite(published)) return published <= now ? Math.floor((now - published) / 86400000) : undefined;
  }
  if (typeof job.ageDays === 'number' && Number.isFinite(job.ageDays) && job.ageDays >= 0) return job.ageDays;
  return parseAgeDays(job.listedAt);
}

/** Unknown dates remain eligible; only a confirmed age beyond the limit excludes. */
export function passesListingAge(job: Pick<JobListing, 'ageDays' | 'listedAt'>, maxAgeDays: number): boolean {
  const age = listingAgeDays(job);
  return age === undefined || age <= maxAgeDays;
}

/** Inclusive whole-day age, matching board labels such as "20 days ago". */
export function listingAgeCutoff(maxAgeDays: number, now = Date.now()): string {
  return new Date(now - (maxAgeDays + 1) * 86400000).toISOString();
}
