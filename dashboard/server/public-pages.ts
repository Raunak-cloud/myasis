import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STATIC_PUBLIC_PAGES: Record<string, string> = {
  '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html',
  '/automate-job-applications-australia': 'automate-job-applications-australia.html',
};

/** Content dates belong to the document, never to a build or crawl date. */
export function publicPageDates(directory: string): Record<string, string> {
  return Object.fromEntries(Object.entries(STATIC_PUBLIC_PAGES).flatMap(([path, file]) => {
    const html = readFileSync(resolve(directory, file), 'utf8');
    const value = html.match(/<meta\s+name="dcterms\.modified"\s+content="(\d{4}-\d{2}-\d{2})"\s*\/?\s*>/i)?.[1];
    if (!value) return [];
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return [];
    return [[path, value]];
  }));
}
