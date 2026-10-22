import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { googleConfigured } from './auth.js';
import { publishedPost, publishedPosts, siteOrigin } from './blog/index.js';
import { renderIndex, renderPost, renderRss, renderSitemap } from './blog/render.js';
import { publicPagePatch } from './marketing/page-publisher.js';
import { applyPagePatch } from './marketing/page-edits.js';
import type { WebsitePatch } from '../src/marketingTypes.js';

const files: Record<string, string> = {
  '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html',
  '/automate-job-applications-australia': 'automate-job-applications-australia.html',
};
export function publicContentPath(path: string): boolean {
  return Object.hasOwn(files, path) || path === '/blog' || path === '/sitemap.xml'
    || path === '/blog/rss.xml' || /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
}

/** Only already-public material is exposed; never accept a filesystem path or arbitrary URL. */
export async function publicWebsiteContent(path: string, directory: string) {
  if (!publicContentPath(path)) return null;
  const origin = siteOrigin();
  if (path === '/sitemap.xml' || path === '/blog/rss.xml') {
    const posts = await publishedPosts();
    return { status: 200, text: path === '/sitemap.xml' ? renderSitemap(posts, origin) : renderRss(posts, origin),
      contentType: path === '/sitemap.xml' ? 'application/xml' : 'application/rss+xml' };
  }
  let status = 200;
  let html: string;
  if (files[path]) html = readFileSync(resolve(directory, files[path]), 'utf8');
  else {
    let parts;
    if (path === '/blog') parts = renderIndex(await publishedPosts(), origin);
    else {
      const post = await publishedPost(path.slice('/blog/'.length));
      if (post) parts = renderPost(post, origin);
      else {
        status = 404;
        parts = { head: '<title>Not found | Owtomate</title><meta name="robots" content="noindex" />',
          body: '<h1>That brief is not here</h1><p>It may have been taken down. <a href="/blog">See every weekly brief</a>.</p>' };
      }
    }
    html = readFileSync(resolve(directory, 'blog.html'), 'utf8').replace('<!--blog:head-->', parts.head).replace('<!--blog:body-->', parts.body);
  }
  let patch: WebsitePatch = {};
  if (status === 200) {
    try { patch = await publicPagePatch(path) ?? {}; } catch { /* Base public content remains available during a DB outage. */ }
    if (Object.keys(patch).length) html = applyPagePatch(html, patch, new URL(path, origin).href);
  }
  return { status, html, patch, googleConfigured: googleConfigured() };
}
