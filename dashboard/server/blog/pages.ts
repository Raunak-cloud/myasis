import { readFileSync, statSync } from 'node:fs';
import { publishedPost, publishedPosts, siteOrigin } from './index.js';
import { renderIndex, renderPost, renderRss, renderSitemap } from './render.js';

/**
 * Serves /blog, each post, the RSS feed and the sitemap.
 *
 * The page shell is `blog.html`: built by Vite like the other content pages,
 * so its stylesheet is hashed and cached like theirs, with two markers the
 * rendered head and body replace. Dev reads the source file, preview the
 * built one; the caller says which.
 */

const HEAD = '<!--blog:head-->';
const BODY = '<!--blog:body-->';
const SLUG = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;

type Req = { method?: string; url?: string };
type Res = { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void };

function shellReader(templateFile: string): () => string {
  let cached: { mtimeMs: number; html: string } | null = null;
  return () => {
    const { mtimeMs } = statSync(templateFile);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const html = readFileSync(templateFile, 'utf8');
      if (!html.includes(HEAD) || !html.includes(BODY)) throw new Error(`${templateFile} is missing the blog markers`);
      cached = { mtimeMs, html };
    }
    return cached.html;
  };
}

export function blogPages(templateFile: string) {
  const shell = shellReader(templateFile);

  const send = (res: Res, status: number, type: string, body: string, maxAge = 300) => {
    res.statusCode = status;
    res.setHeader('Content-Type', `${type}; charset=utf-8`);
    // Short: a new post or a hidden one should show within minutes, and the pages are cheap.
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.end(body);
  };
  const page = (res: Res, status: number, parts: { head: string; body: string }) =>
    send(res, status, 'text/html', shell().replace(HEAD, parts.head).replace(BODY, parts.body));

  return (req: Req, res: Res, next: (error?: unknown) => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/sitemap.xml' && path !== '/blog.html' && !path.startsWith('/blog')) return next();

    void (async () => {
      const origin = siteOrigin();
      // The shell itself is not a page.
      if (path === '/blog.html' || path === '/blog/') {
        res.statusCode = 301;
        res.setHeader('Location', '/blog');
        return res.end();
      }
      if (path === '/sitemap.xml') return send(res, 200, 'application/xml', renderSitemap(await publishedPosts(), origin), 3_600);
      if (path === '/blog/rss.xml') return send(res, 200, 'application/rss+xml', renderRss(await publishedPosts(), origin), 3_600);
      if (path === '/blog') return page(res, 200, renderIndex(await publishedPosts(), origin));

      const slug = path.match(SLUG)?.[1];
      const post = slug ? await publishedPost(slug) : null;
      if (post) {
        // One address per post: a trailing slash is sent to the canonical one.
        if (path.endsWith('/')) {
          res.statusCode = 301;
          res.setHeader('Location', `/blog/${post.slug}`);
          return res.end();
        }
        return page(res, 200, renderPost(post, origin));
      }
      return page(res, 404, {
        head: '<title>Not found | Owtomate</title>\n    <meta name="robots" content="noindex" />',
        body: '<h1>That brief is not here</h1><p>It may have been taken down. <a href="/blog">See every weekly brief</a>.</p>',
      });
    })().catch(next);
  };
}
