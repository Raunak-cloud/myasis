import { isIP } from 'node:net';
import { parseHTML } from 'linkedom';

/** Branded PageUp/Clinch pages reached from a provider-owned career site. */
export function brandedPageupIdentity(raw: string): { namespace: string; posting: string } | null {
  try {
    const u = new URL(raw), host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || isIP(host)
      || !host.includes('.') || /(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host)) return null;
    const match = u.pathname.match(/^(\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?jobs)\/([A-Za-z0-9_%.-]{1,500})\/?$/);
    if (!match || /^(search|apply|login|register|\.{1,2})$/i.test(match[2]) || /%2f|%5c/i.test(match[2])) return null;
    return { namespace: u.origin + match[1], posting: match[2] };
  } catch { return null; }
}

export function brandedPageupSearch(html: string, url: string) {
  const { document } = parseHTML(html), base = new URL(url);
  const form = document.querySelector('form.job-search-results-form');
  if (!form || !form.querySelector('[name="query"]') || !document.querySelector('.job-search-results-content')) {
    throw Error('Branded PageUp search layout is not recognised.');
  }
  const action = new URL(form.getAttribute('action') || url, url);
  if (action.origin !== base.origin || !/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?jobs\/search\/?$/.test(action.pathname)) {
    throw Error('Branded PageUp search changed employer.');
  }
  // Use the publisher's Australian country option when its public form offers it.
  if (form.querySelector('input[name="country_codes[]"][value="AU"],select[name="country_codes[]"] option[value="AU"]')) {
    action.searchParams.set('country_codes[]', 'AU');
  }
  const jobs = [...document.querySelectorAll('.job-search-results-card-title a[href], .job-search-results-title a[href]')].flatMap(anchor => {
    try {
    const destination = new URL(anchor.getAttribute('href')!, url), identity = brandedPageupIdentity(destination.href);
    if (!identity || destination.origin !== base.origin) return [];
    const card = anchor.closest('.job-search-results-card,tr');
    const title = anchor.textContent?.trim(), location = card?.querySelector('.job-component-location,.job-search-results-location')?.textContent?.trim();
    return title && location ? [{ url: destination.href, title, location: location.replace(/\s+/g, ' '),
      teaser: card?.querySelector('.job-search-results-summary')?.textContent?.trim() }] : [];
    } catch { return []; }
  });
  const page = Number(base.searchParams.get('page') || 1);
  const hasNext = [...document.querySelectorAll('.pagination-container a[href]')].some(a => {
    try { return Number(new URL(a.getAttribute('href')!, url).searchParams.get('page')) > page; } catch { return false; }
  });
  return { action: action.href, jobs, exhausted: Boolean(document.querySelector('.pagination-container')) && !hasNext };
}

/** Read the publisher's JobPosting, never a recommended card or a site footer. */
export function brandedPageupPosting(html: string, url: string): Record<string, any> {
  const { document } = parseHTML(html), found: Record<string, any>[] = [];
  const walk = (value: any, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => walk(item, depth + 1)); return; }
    if ([value['@type']].flat().includes('JobPosting')) found.push(value);
    if (value['@graph']) walk(value['@graph'], depth + 1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
    try { walk(JSON.parse(script.textContent || '')); } catch { /* Other malformed metadata cannot create a vacancy. */ }
  }
  const same = (raw: string) => { try { return new URL(raw, url).href.replace(/\/$/, '') === url.replace(/\/$/, ''); } catch { return false; } };
  const posting = found.find(p => typeof p.url === 'string' && same(p.url))
    ?? (found.length === 1 && !found[0].url ? found[0] : undefined);
  if (!posting || typeof posting.title !== 'string' || typeof posting.description !== 'string') {
    throw Error('Branded PageUp job is closed, changed or missing its description.');
  }
  return posting;
}
