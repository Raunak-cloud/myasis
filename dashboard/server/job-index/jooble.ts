import { plain } from './extract.js';
import type { JoobleJob, JoobleSearchResult } from './types.js';

const origin = 'https://au.jooble.org';
const pageSize = 20;
const searchFieldLimit = 160;

export class JoobleSearchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function listingUrl(value: unknown, key: string): URL | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || !/^\/(?:jdp|desc)\/-?\d+\/?$/.test(url.pathname)) return null;
    url.hash = '';
    if (url.href.includes(key) || decodeURIComponent(url.href).includes(key)) return null;
    if ([...url.searchParams].some(([name, value]) => name.includes(key) || value.includes(key))) return null;
    return url;
  } catch {
    return null;
  }
}

function displayText(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.includes(key)) return '';
  const text = plain(value.slice(0, 1000), 250).replace(/\s+/g, ' ');
  return text.includes(key) ? '' : text;
}

export async function searchJooble(apiKey: string, input: unknown, read: typeof fetch = fetch): Promise<JoobleSearchResult> {
  const fields = record(input);
  const keywords = typeof fields?.keywords === 'string' ? fields.keywords.trim() : '';
  const location = typeof fields?.location === 'string' ? fields.location.trim() : '';
  const page = fields?.page;
  if (!keywords || !location || keywords.length > searchFieldLimit || location.length > searchFieldLimit) {
    throw new JoobleSearchError(`Enter keywords and a location of up to ${searchFieldLimit} characters each.`, 400);
  }
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) {
    throw new JoobleSearchError('Choose a valid page number.', 400);
  }

  const key = apiKey.trim();
  if (!key || key === '.' || key === '..') {
    throw new JoobleSearchError('Jooble is not configured. Add its Australian API key on the server.', 503);
  }
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await read(`${origin}/api/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keywords, location, page: String(page), ResultOnPage: pageSize }),
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) throw new JoobleSearchError('Jooble search timed out. Try again.', 504);
    throw new JoobleSearchError('Could not connect to Jooble. Try again.', 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new JoobleSearchError('Jooble denied access. Check the Australian API key in the server settings.', 503);
  }
  if (response.status === 429) {
    throw new JoobleSearchError('Jooble’s search limit has been reached. Try again after the daily reset at midnight UTC.', 429);
  }
  if (!response.ok) throw new JoobleSearchError('Jooble search is unavailable. Try again.', 502);

  let data: Record<string, unknown> | null;
  try {
    data = record(await response.json());
  } catch {
    if (signal.aborted) throw new JoobleSearchError('Jooble search timed out. Try again.', 504);
    throw new JoobleSearchError('Jooble sent an unreadable search response.', 502);
  }
  const listings = data?.jobs;
  const total = data?.totalCount;
  if (!Array.isArray(listings) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new JoobleSearchError('Jooble sent an invalid search response.', 502);
  }

  const jobs: JoobleJob[] = [];
  const seen = new Set<string>();
  for (const value of listings.slice(0, pageSize)) {
    const listing = record(value);
    if (!listing) continue;
    const url = listingUrl(listing.link, key);
    const title = displayText(listing.title, key);
    if (!url || !title) continue;
    const id = url.pathname.split('/')[2];
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      title,
      company: displayText(listing.company, key),
      location: displayText(listing.location, key),
      salary: displayText(listing.salary, key),
      type: displayText(listing.type, key),
      source: displayText(listing.source, key),
      url: url.href,
    });
  }
  return { jobs, page, hasMore: listings.length > 0 && page < Math.ceil(total / pageSize) };
}
