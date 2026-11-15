import { parseHTML } from 'linkedom';
import type { JobListing } from './types.js';
import type { DiscoverySearch } from './discovery-search.js';
import { boardAgeWindow } from './discovery-policy.js';
import { parseAgeDays } from './listing-age.js';

const ORIGIN = 'https://au.jora.com';
const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Retain the posting identity, without Jora's per-search tracking parameters. */
export function joraPosting(raw: string): { id: string; url: string } | null {
  try {
    const url = new URL(raw, ORIGIN);
    const id = url.pathname.match(/^\/job\/(?!rd\/)[^/]+-([a-f0-9]{32})\/?$/i)?.[1];
    if (url.origin !== ORIGIN || url.username || url.password || !id) return null;
    return { id: `jora-${id.toLowerCase()}`, url: `${ORIGIN}${url.pathname.replace(/\/$/, '')}` };
  } catch { return null; }
}

export function joraSearchUrl(keyword: string, page: number, maxAgeDays: number, scope?: DiscoverySearch): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid Jora search page.');
  const url = new URL('/j', ORIGIN);
  url.searchParams.set('q', keyword);
  url.searchParams.set('l', scope?.location.trim() || 'Australia');
  url.searchParams.set('p', String(page));
  url.searchParams.set('st', 'date');
  const age = boardAgeWindow(maxAgeDays, [1, 7, 14, 30]);
  if (age !== undefined) url.searchParams.set('a', `${age}d`);
  // Jora has no verified transport equivalent for every saved arrangement or
  // radius. The existing matching pipeline still applies those preferences.
  return url.href;
}

export function assertJoraContent(text: string): void {
  if (/verify (?:that )?you(?:'re| are) human|security verification|access denied|just a moment|captcha|checking your browser/i.test(text)) {
    throw new Error('Jora access requires security verification.');
  }
}

/** Only accept observed result cards or an explicit empty-results message. */
export function parseJoraSearch(html: string): JobListing[] {
  const { document } = parseHTML(html);
  const cards = [...document.querySelectorAll('#jobresults [data-job-card="true"]')];
  if (!cards.length) {
    const text = clean(document.body?.textContent || document.textContent);
    assertJoraContent(text);
    if (/\b(?:no jobs found|no matching jobs|0 jobs\b|could(?:n.t| not) find any jobs)/i.test(text)) return [];
    throw new Error('Jora search results could not be read.');
  }
  const jobs = new Map<string, JobListing>();
  for (const card of cards) {
    const link = card.querySelector('h2 a.job-link');
    const posting = joraPosting(link?.getAttribute('href') ?? '');
    const title = clean(link?.textContent), company = clean(card.querySelector('.job-company')?.textContent);
    if (!posting || !title || !company) continue;
    const badges = [...card.querySelectorAll('.badge')].map(node => clean(node.textContent));
    const salary = clean(card.textContent).match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?\s*(?:a|an|per)\s*(?:year|hour|annum)/i)?.[0];
    jobs.set(posting.id, { ...posting, title, company, platform: 'jora', source: 'search',
      location: clean(card.querySelector('.job-location')?.textContent), salary,
      workArrangement: badges.filter(value => /hybrid|remote|on.?site/i.test(value)).join(', ') || undefined,
      ageDays: parseAgeDays(clean(card.querySelector('.job-listed-date')?.textContent)),
      teaser: clean(card.querySelector('.job-abstract')?.textContent),
      applicationMode: 'unknown', listingSourceUrl: posting.url });
  }
  if (!jobs.size) throw new Error('Jora returned job cards without readable vacancy identities.');
  return [...jobs.values()];
}

export function parseJoraDetail(html: string, stub: JobListing): { job: JobListing; redirect: string } {
  const source = joraPosting(stub.listingSourceUrl ?? stub.url);
  if (stub.platform !== 'jora' || source?.id !== stub.id) throw new Error('Invalid Jora listing identity.');
  const { document } = parseHTML(html);
  const root = document.querySelector('#job-view');
  if (!root) { assertJoraContent(clean(document.body?.textContent || document.textContent)); throw new Error('The Jora vacancy could not be read.'); }
  const descriptionNode = root.querySelector('#job-description-container');
  descriptionNode?.querySelectorAll('p, li, div, h2, h3, br').forEach(node => node.append(' '));
  const description = clean(descriptionNode?.textContent);
  const title = clean(root.querySelector('h1.job-title')?.textContent);
  const link = root.querySelector('a.apply-button')?.getAttribute('href');
  if (!description || !title || !link) throw new Error('The Jora vacancy has no readable description or application link.');
  const redirect = new URL(link, source.url);
  // Follow only this posting's own outbound link. Public destination validation
  // runs on every browser navigation, including redirects.
  if (redirect.origin !== ORIGIN || redirect.pathname !== `/job/rd/${stub.id.slice(5)}`) throw new Error('The Jora application link does not identify this vacancy.');
  return { redirect: redirect.href, job: { ...stub, url: source.url, listingSourceUrl: source.url, title, description,
    company: clean(root.querySelector('#company-location-container .company')?.textContent) || stub.company,
    location: clean(root.querySelector('#company-location-container .location')?.textContent) || stub.location,
    ageDays: parseAgeDays(clean(root.querySelector('#job-meta .listed-date')?.textContent)) ?? stub.ageDays } };
}
