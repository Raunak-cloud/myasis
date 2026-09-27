import { weekOf } from './index.js';
import { renderPost, renderRss, renderSitemap, type StoredPost } from './render.js';
import type { Brief } from './signals.js';
import { structuralProblems, type Article } from './writer.js';

/**
 * The weekly brief publishes with nobody watching, so the parts code is
 * responsible for are checked here: which week it is, what counts as a
 * citation, what the writer is sent back for, and that model text can never
 * become markup. Run with: npx tsx server/blog/blog.test.ts
 */

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// Sydney is UTC+10 until daylight saving starts on 4 October 2026.
const sundayNoon = weekOf(new Date('2026-09-27T02:00:00Z'));
check('a Sunday belongs to the week that began the Monday before', sundayNoon.week === '2026-09-21' && sundayNoon.due, JSON.stringify(sundayNoon));
const mondayEarly = weekOf(new Date('2026-09-27T19:00:00Z')); // 5am Monday in Sydney
check('Monday before 6am is the new week, not yet due', mondayEarly.week === '2026-09-28' && !mondayEarly.due, JSON.stringify(mondayEarly));
const mondayLate = weekOf(new Date('2026-09-27T20:30:00Z')); // 6:30am Monday in Sydney
check('Monday from 6am is due', mondayLate.week === '2026-09-28' && mondayLate.due, JSON.stringify(mondayLate));

const brief: Brief = {
  week: '2026-09-21',
  gatheredAt: '2026-09-21T20:00:00.000Z',
  searches: [
    { seed: 'ai jobs', suggestion: 'ai jobs australia', rank: 1, isNew: true },
    { seed: 'part time jobs', suggestion: 'part time jobs sydney', rank: 1, isNew: false },
    { seed: 'casual jobs', suggestion: 'casual jobs for students', rank: 2, isNew: false },
    { seed: 'remote jobs', suggestion: 'remote jobs australia', rank: 1, isNew: false },
  ],
  sources: [
    { ref: 'S1', publisher: 'Australian Bureau of Statistics', title: 'Labour Force', url: 'https://www.abs.gov.au/a', published: '2026-09-24', excerpt: '' },
    { ref: 'S2', publisher: 'Jobs and Skills Australia', title: 'Job ads', url: 'https://www.jobsandskills.gov.au/b', published: '2026-09-23', excerpt: '' },
    { ref: 'S3', publisher: 'Indeed Hiring Lab <Australia>', title: 'AI titles', url: 'https://www.hiringlab.org/au/c', published: null, excerpt: '' },
  ],
  listingSample: null,
  unavailable: [],
};

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const article: Article = {
  title: 'AI jobs in Australia this week',
  slug: 'ai-jobs-australia-this-week',
  metaDescription: 'What Australians searched for this week, what the latest labour-market figures say, and what job seekers can do about it now.',
  focusKeyword: 'ai jobs australia',
  targetSearches: ['ai jobs australia', 'remote jobs australia', 'part time jobs sydney', 'casual jobs for students'],
  lead: 'Unemployment rose to 4.6% [S1]. Ads edged up [S2, S3].',
  sections: [
    { heading: 'What changed [S1]', paragraphs: [`${words(250)} [S1]`], bullets: ['<script>alert(1)</script> a bullet [S9]'] },
    { heading: 'Searches', paragraphs: [words(250)], bullets: [] },
    { heading: 'Actions', paragraphs: [words(250)], bullets: [] },
    { heading: 'Outlook', paragraphs: [words(150)], bullets: [] },
  ],
  takeaways: ['One [S1]', 'Two [S2;S3]', 'Three'],
};

const problems = structuralProblems(article, brief);
check('a citation to a source that does not exist is sent back', problems.some((p) => p.includes('S9')), problems.join(' | '));
check('grouped citations count every source they name', !problems.some((p) => p.includes('source(s) cited')), problems.join(' | '));
check('nothing else is wrong with a well-formed draft', problems.length === 1, problems.join(' | '));

const invented = structuralProblems({ ...article, sections: article.sections.map((s) => ({ ...s, bullets: [] })), focusKeyword: 'jobs near me', targetSearches: [...article.targetSearches, 'best jobs ever'] }, brief);
check('a focus keyword nobody searched is sent back', invented.some((p) => p.includes('"jobs near me"')), invented.join(' | '));
check('an invented target search is sent back', invented.some((p) => p.includes('"best jobs ever"')), invented.join(' | '));

const short = structuralProblems({ ...article, sections: article.sections.slice(0, 1).map((s) => ({ ...s, paragraphs: ['Too short [S1]'], bullets: [] })) }, brief);
check('a draft that is not an article is sent back', short.some((p) => p.includes('words')) && short.some((p) => p.includes('sections')), short.join(' | '));

const post: StoredPost = {
  slug: article.slug,
  title: article.title,
  description: article.metaDescription,
  article,
  brief,
  publishedAt: new Date('2026-09-21T20:00:00Z'),
  updatedAt: new Date('2026-09-21T20:00:00Z'),
};
const { head, body } = renderPost(post, 'https://owtomate.com');
check('model text is escaped, never markup', !body.includes('<script>') && body.includes('&lt;script&gt;'));
check('a grouped citation links each source', body.includes('href="#source-2"') && body.includes('href="#source-3"') && body.includes('[<a'));
check('a citation to an unknown source is dropped from the page', !body.includes('S9') && !body.includes('source-9'));
check('headings carry no citation markers', body.includes('<h2>What changed</h2>'));
check('publisher names are escaped in the source list', body.includes('Indeed Hiring Lab &lt;Australia&gt;'));
check('only cited sources are listed', (body.match(/id="source-/g) ?? []).length === 3);
check('a search new this week is marked', /ai jobs australia <span class="blog-new">/.test(body));
check('the page has a canonical address and article data', head.includes('rel="canonical" href="https://owtomate.com/blog/ai-jobs-australia-this-week"') && head.includes('"@type":"Article"'));
check('structured data cannot close its script tag', !/<\/script>[\s\S]*<\/script>/.test(head.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')));

const summary = [{ slug: post.slug, title: post.title, description: post.description, publishedAt: post.publishedAt, updatedAt: post.updatedAt }];
const sitemap = renderSitemap(summary, 'https://owtomate.com');
check('the sitemap lists the static pages, the blog and each post', ['https://owtomate.com/</loc>', '/privacy</loc>', '/blog</loc>', `/blog/${post.slug}</loc>`].every((s) => sitemap.includes(s)));
const rss = renderRss(summary, 'https://owtomate.com');
check('the feed links each post', rss.includes(`<link>https://owtomate.com/blog/${post.slug}</link>`) && rss.includes('<pubDate>Mon, 21 Sep 2026 20:00:00 GMT</pubDate>'));

console.log(bad ? `\n${bad} check(s) failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);
