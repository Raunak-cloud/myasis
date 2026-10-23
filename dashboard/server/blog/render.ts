import { CITATION, refsIn, type Article } from './writer.js';
import type { Brief, BriefSource } from './signals.js';
import { STATIC_PUBLIC_PAGES } from '../public-pages.js';

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
const BLOG_TITLE = 'Owtomate Job Search Guides';
const BLOG_DESCRIPTION = 'Practical job search guides and Australian job-market research, with sources you can check.';

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

export function renderPost(post: StoredPost, origin: string, published: PostSummary[] = []): { head: string; body: string } {
  const { article, brief } = post;
  const url = `${origin}${postPath(post.slug)}`;
  const sources = new Map(brief.sources.map((s) => [s.ref, s]));
  const cited = new Set([...JSON.stringify(article).matchAll(CITATION)].flatMap((m) => refsIn(m[1])));
  const newThisWeek = new Set(brief.searches.filter((s) => s.isNew).map((s) => s.suggestion));
  const words = (text: string) => new Set((text.toLowerCase().match(/[a-z]{2,}/g) ?? []).filter(word => !['the', 'and', 'for', 'how', 'in', 'to', 'of', 'as', 'an', 'on', 'at', 'by', 'is', 'or', 'jobs', 'australia', 'australian', 'what', 'with', 'that', 'this', 'from', 'your', 'find'].includes(word)));
  const topic = words(`${post.title} ${article.focusKeyword}`);
  const related = published.filter(item => item.slug !== post.slug).map(item => ({ item,
    overlap: [...words(item.title)].filter(word => topic.has(word)).length,
  })).filter(item => item.overlap > 0).sort((a, b) => b.overlap - a.overlap || b.item.publishedAt.getTime() - a.item.publishedAt.getTime()).slice(0, 3);

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
    const date = s.published ? `, ${longDate(new Date(`${s.published}T00:00:00Z`))}` : s.collectedAt ? `, checked ${longDate(new Date(s.collectedAt))}` : '';
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
      <nav aria-label="Related guides">
        <h2>Related guides</h2>
        <ul><li><a href="/automate-job-applications-australia">How to automate job applications in Australia</a></li>
        ${related.map(({ item }) => `<li><a href="${postPath(item.slug)}">${escapeHtml(item.title)}</a></li>`).join('\n')}</ul>
      </nav>
      ${brief.marketing ? `<section class="legal-lead blog-cta" aria-label="Explore Owtomate"><p><a href="${escapeHtml(brief.marketing.ctaUrl)}"><strong>${escapeHtml(brief.marketing.ctaLabel)}</strong></a></p></section>` : `<section class="legal-lead blog-cta" aria-label="Try Owtomate">
        <p><strong>Spending your evenings on applications?</strong> Owtomate applies to jobs that match your resume on SEEK and Indeed, from your own account, and asks you whenever it cannot answer honestly.</p>
        <p><a href="/api/auth/google" rel="nofollow"><strong>Start free — five applications, no card</strong></a></p>
      </section>`}
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
      <p class="legal-lead">${escapeHtml(BLOG_DESCRIPTION)} <a href="/blog/rss.xml">RSS feed</a>.</p>
      <p>New to application automation? Read <a href="/automate-job-applications-australia">how to automate job applications in Australia</a>, including manual starts and reviewing prepared applications.</p>
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
${posts.length ? `    <lastBuildDate>${new Date(Math.max(...posts.map(post => post.updatedAt.getTime()))).toUTCString()}</lastBuildDate>\n` : ''}${items}
  </channel>
</rss>
`;
}

export function renderSitemap(posts: PostSummary[], origin: string, staticDates: Record<string, string> = {}): string {
  const entry = (path: string, lastmod?: string) => `  <url>
    <loc>${escapeXml(`${origin}${path}`)}</loc>
${lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>\n` : ''}  </url>`;
  const newest = posts.length ? day(new Date(Math.max(...posts.map(post => post.updatedAt.getTime())))) : undefined;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
    ...Object.keys(STATIC_PUBLIC_PAGES).map(path => entry(path, staticDates[path])),
    entry('/blog', newest),
    ...posts.map((post) => entry(postPath(post.slug), day(post.updatedAt))),
  ].join('\n')}
</urlset>
`;
}
