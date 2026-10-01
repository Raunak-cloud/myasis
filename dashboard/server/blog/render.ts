import { CITATION, refsIn, type Article } from './writer.js';
import type { Brief, BriefSource } from './signals.js';

/**
 * The blog as HTML, RSS and sitemap.
 *
 * Pages are rendered on the server from stored posts and dropped into the
 * built `blog.html` shell, so a new post is live the moment it is stored —
 * no rebuild, no deploy — and a crawler reads the whole article without
 * running a script. Everything the model wrote is escaped; the only markup
 * added to its text is the citation link, made here from a validated ref.
 */

export interface StoredPost {
  slug: string;
  title: string;
  description: string;
  article: Article;
  brief: Brief;
  publishedAt: Date;
  updatedAt: Date;
}

export interface PostSummary {
  slug: string;
  title: string;
  description: string;
  publishedAt: Date;
  updatedAt: Date;
}

const SITE_NAME = 'Owtomate';
const BLOG_TITLE = 'Australian Job Market Brief';
const BLOG_DESCRIPTION = 'A weekly brief on Australian job trends: what people are searching for, what the latest labour-market figures say, and what job seekers can do about it.';

/** Content pages outside the blog, for the sitemap. Update lastmod when a page changes. */
const STATIC_PAGES: Array<{ path: string; lastmod: string; changefreq: string; priority: string }> = [
  { path: '/', lastmod: '2026-09-23', changefreq: 'weekly', priority: '1.0' },
  { path: '/automate-job-applications-australia', lastmod: '2026-09-23', changefreq: 'monthly', priority: '0.8' },
  { path: '/privacy', lastmod: '2026-09-18', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', lastmod: '2026-09-18', changefreq: 'yearly', priority: '0.3' },
];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const escapeXml = escapeHtml;

/** JSON inside a <script> must not be able to close it. */
const jsonLd = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

const day = (date: Date) => date.toISOString().slice(0, 10);
const longDate = (date: Date) => date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });

/** Model prose to HTML: escaped, with [S3, S8] turned into links to sources 3 and 8. */
function prose(text: string, sources: Map<string, BriefSource>): string {
  return escapeHtml(text).replace(CITATION, (_, group: string) => {
    const links = refsIn(group).filter((ref) => sources.has(ref)).map((ref) => {
      const n = ref.slice(1);
      return `<a href="#source-${n}" aria-label="Source ${n}: ${escapeHtml(sources.get(ref)!.publisher)}">${n}</a>`;
    });
    return links.length ? `<sup class="blog-cite">[${links.join(', ')}]</sup>` : '';
  });
}

/** Headings and descriptions carry no citations. */
const UNCITED = new RegExp(String.raw`\s*` + CITATION.source, 'g');
const plain = (text: string) => escapeHtml(text.replace(UNCITED, ''));

export function postPath(slug: string): string {
  return `/blog/${slug}`;
}

function head(options: { title: string; description: string; canonical: string; type: 'article' | 'website'; extra?: string; structured: unknown }): string {
  return [
    `<title>${escapeHtml(options.title)}</title>`,
    `<meta name="description" content="${escapeHtml(options.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(options.canonical)}" />`,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />',
    `<meta property="og:type" content="${options.type}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    '<meta property="og:locale" content="en_AU" />',
    `<meta property="og:url" content="${escapeHtml(options.canonical)}" />`,
    `<meta property="og:title" content="${escapeHtml(options.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(options.description)}" />`,
    `<meta property="og:image" content="${escapeHtml(new URL('/og-image.png', options.canonical).href)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    options.extra ?? '',
    `<script type="application/ld+json">${jsonLd(options.structured)}</script>`,
  ].filter(Boolean).join('\n    ');
}

function publisher(origin: string) {
  return {
    '@type': 'Organization',
    name: SITE_NAME,
    url: `${origin}/`,
    logo: { '@type': 'ImageObject', url: `${origin}/icon-512.png`, width: 512, height: 512 },
  };
}

export function renderPost(post: StoredPost, origin: string): { head: string; body: string } {
  const { article, brief } = post;
  const url = `${origin}${postPath(post.slug)}`;
  const sources = new Map(brief.sources.map((s) => [s.ref, s]));
  const cited = new Set([...JSON.stringify(article).matchAll(CITATION)].flatMap((m) => refsIn(m[1])));
  const newThisWeek = new Set(brief.searches.filter((s) => s.isNew).map((s) => s.suggestion));

  const sections = article.sections.map((section) => [
    `<h2>${plain(section.heading)}</h2>`,
    ...section.paragraphs.map((p) => `<p>${prose(p, sources)}</p>`),
    section.bullets.length ? `<ul>${section.bullets.map((b) => `<li>${prose(b, sources)}</li>`).join('')}</ul>` : '',
  ].join('\n')).join('\n');

  const searches = article.targetSearches.length
    ? `<aside class="blog-searches" aria-labelledby="searches-heading">
        <h2 id="searches-heading">Searches this brief answers</h2>
        <ul>${article.targetSearches.map((s) => `<li>${escapeHtml(s)}${newThisWeek.has(s) ? ' <span class="blog-new">new this week</span>' : ''}</li>`).join('')}</ul>
      </aside>`
    : '';

  const sourceList = brief.sources.filter((s) => cited.has(s.ref)).map((s) => {
    const n = s.ref.slice(1);
    const date = s.published ? `, ${longDate(new Date(`${s.published}T00:00:00Z`))}` : '';
    return `<li id="source-${n}" value="${n}">${escapeHtml(s.publisher)}, <a href="${escapeHtml(s.url)}" rel="noopener">${escapeHtml(s.title)}</a>${escapeHtml(date)}</li>`;
  }).join('');

  const body = `<article class="blog-post">
      <nav class="blog-crumbs" aria-label="Breadcrumb"><a href="/blog">${BLOG_TITLE}</a></nav>
      <h1>${plain(article.title)}</h1>
      <p class="legal-meta">Published ${escapeHtml(longDate(post.publishedAt))}${day(post.updatedAt) !== day(post.publishedAt) ? ` · updated ${escapeHtml(longDate(post.updatedAt))}` : ''} · Owtomate research</p>
      <p class="legal-lead">${prose(article.lead, sources)}</p>
      ${searches}
      ${sections}
      <h2>Key takeaways</h2>
      <ul>${article.takeaways.map((t) => `<li>${prose(t, sources)}</li>`).join('')}</ul>
      <h2 id="sources">Sources</h2>
      <ol class="blog-sources">${sourceList}</ol>
      <section class="legal-lead blog-cta" aria-label="Try Owtomate">
        <p><strong>Spending your evenings on applications?</strong> Owtomate applies to jobs that match your résumé on SEEK and Indeed, from your own account, and asks you whenever it cannot answer honestly.</p>
        <p><a href="/api/auth/google" rel="nofollow"><strong>Start free — five applications, no card</strong></a></p>
      </section>
    </article>`;

  const structured = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: article.title,
        description: post.description,
        datePublished: post.publishedAt.toISOString(),
        dateModified: post.updatedAt.toISOString(),
        inLanguage: 'en-AU',
        mainEntityOfPage: url,
        keywords: [article.focusKeyword, ...article.targetSearches].join(', '),
        author: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
        publisher: publisher(origin),
        image: `${origin}/og-image.png`,
        citation: brief.sources.filter((s) => cited.has(s.ref)).map((s) => s.url),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: BLOG_TITLE, item: `${origin}/blog` },
          { '@type': 'ListItem', position: 3, name: article.title, item: url },
        ],
      },
    ],
  };

  return {
    head: head({
      title: `${article.title} | ${SITE_NAME}`,
      description: post.description,
      canonical: url,
      type: 'article',
      extra: `<meta property="article:published_time" content="${post.publishedAt.toISOString()}" />\n    <meta property="article:modified_time" content="${post.updatedAt.toISOString()}" />`,
      structured,
    }),
    body,
  };
}

export function renderIndex(posts: PostSummary[], origin: string): { head: string; body: string } {
  const url = `${origin}/blog`;
  const items = posts.map((post) => `<li class="blog-item">
        <p class="legal-meta">${escapeHtml(longDate(post.publishedAt))}</p>
        <h2><a href="${postPath(post.slug)}">${escapeHtml(post.title)}</a></h2>
        <p>${escapeHtml(post.description)}</p>
      </li>`).join('\n');

  const body = `<h1>${BLOG_TITLE}</h1>
      <p class="legal-lead">${escapeHtml(BLOG_DESCRIPTION)} New every Monday. <a href="/blog/rss.xml">RSS feed</a>.</p>
      ${posts.length ? `<ol class="blog-list">${items}</ol>` : '<p>The first brief is on its way.</p>'}`;

  return {
    head: head({
      title: `${BLOG_TITLE}: Weekly Job Trends | ${SITE_NAME}`,
      description: BLOG_DESCRIPTION,
      canonical: url,
      type: 'website',
      structured: {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        '@id': `${url}#blog`,
        name: BLOG_TITLE,
        description: BLOG_DESCRIPTION,
        url,
        inLanguage: 'en-AU',
        publisher: publisher(origin),
        blogPost: posts.slice(0, 20).map((post) => ({
          '@type': 'BlogPosting',
          headline: post.title,
          url: `${origin}${postPath(post.slug)}`,
          datePublished: post.publishedAt.toISOString(),
        })),
      },
    }),
    body,
  };
}

export function renderRss(posts: PostSummary[], origin: string): string {
  const items = posts.map((post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${origin}${postPath(post.slug)}</link>
      <guid isPermaLink="true">${origin}${postPath(post.slug)}</guid>
      <pubDate>${post.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(post.description)}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`${BLOG_TITLE} | ${SITE_NAME}`)}</title>
    <link>${origin}/blog</link>
    <atom:link href="${origin}/blog/rss.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(BLOG_DESCRIPTION)}</description>
    <language>en-au</language>
${posts[0] ? `    <lastBuildDate>${posts[0].updatedAt.toUTCString()}</lastBuildDate>\n` : ''}${items}
  </channel>
</rss>
`;
}

export function renderSitemap(posts: PostSummary[], origin: string): string {
  const entry = (path: string, lastmod: string, changefreq: string, priority: string) => `  <url>
    <loc>${escapeXml(`${origin}${path}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
  const newest = posts[0] ? day(posts[0].updatedAt) : STATIC_PAGES[0].lastmod;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
    ...STATIC_PAGES.map((page) => entry(page.path, page.lastmod, page.changefreq, page.priority)),
    entry('/blog', newest, 'weekly', '0.7'),
    ...posts.map((post) => entry(postPath(post.slug), day(post.updatedAt), 'yearly', '0.6')),
  ].join('\n')}
</urlset>
`;
}
