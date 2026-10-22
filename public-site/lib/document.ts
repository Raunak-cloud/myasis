import { cache } from 'react';
import { load } from 'cheerio';
import type { Metadata } from 'next';
import type { WebsitePatch } from '../../dashboard/src/marketingTypes';

export interface PublicDocument { status: number; html?: string; text?: string; contentType?: string; patch?: WebsitePatch; googleConfigured?: boolean }
export const getDocument = cache(async (path: string): Promise<PublicDocument> => {
  const origin = process.env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5180';
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('DASHBOARD_ORIGIN must be loopback HTTP');
  const url = new URL('/api/public/website', origin);
  url.searchParams.set('path', path);
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return { status: 404 };
  if (!response.ok) throw new Error('Public content is temporarily unavailable');
  return response.json();
});

export function parseDocument(document: PublicDocument) {
  const $ = load(document.html ?? '');
  const meta = (name: string) => $(`meta[name="${name}"],meta[property="${name}"]`).first().attr('content');
  const canonical = $('link[rel="canonical"]').attr('href');
  const structuredData = $('script[type="application/ld+json"]').toArray().flatMap(element => {
    try { return [JSON.parse($(element).text())]; } catch { return []; }
  });
  const languages = Object.fromEntries($('link[rel="alternate"][hreflang]').toArray().map(element => [$(element).attr('hreflang')!, $(element).attr('href')!]));
  const other = Object.fromEntries($('meta[name]').toArray().filter(element => !['viewport', 'description', 'robots', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'theme-color'].includes($(element).attr('name')!)).map(element => [$(element).attr('name')!, $(element).attr('content') ?? '']));
  const metadata: Metadata = {
    metadataBase: new URL(canonical ?? 'https://owtomate.com/'),
    title: $('title').text(), description: meta('description'),
    robots: meta('robots') ?? (document.status === 404 ? 'noindex' : 'index, follow'),
    alternates: { canonical, languages, types: { 'application/rss+xml': '/blog/rss.xml' } },
    icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' }], apple: '/apple-touch-icon.png' },
    manifest: '/site.webmanifest', other,
    openGraph: { type: meta('og:type') === 'article' ? 'article' : 'website', url: meta('og:url') ?? canonical,
      title: meta('og:title') ?? $('title').text(), description: meta('og:description') ?? meta('description'),
      siteName: 'Owtomate', locale: 'en_AU', images: meta('og:image') ? [{ url: meta('og:image')!, alt: meta('og:image:alt'), width: Number(meta('og:image:width')) || undefined, height: Number(meta('og:image:height')) || undefined }] : undefined,
      ...(meta('og:type') === 'article' ? { publishedTime: meta('article:published_time'), modifiedTime: meta('article:modified_time') } : {}) },
    twitter: { card: 'summary_large_image', title: meta('twitter:title') ?? $('title').text(),
      description: meta('twitter:description') ?? meta('description'), images: meta('twitter:image') ? [meta('twitter:image')!] : undefined },
  };
  $('#site-header-root').remove();
  $('script').remove();
  return { metadata, structuredData, body: $('body').html() ?? '', lang: $('html').attr('lang') ?? 'en-AU' };
}
