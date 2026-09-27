/**
 * Where the weekly job-market post gets its facts. Changing what the blog
 * watches is an edit to this file and nothing else.
 *
 * Two kinds of signal:
 *
 * - Searches: what people in Australia type into Google, read from Google's
 *   public autocomplete for each seed below. The order Google returns is its
 *   own popularity ranking, and comparing one week's list with the last is
 *   what surfaces a rising search.
 * - Sources: published labour-market reporting the article may cite. Only
 *   publishers whose feeds and pages are open for reuse with attribution are
 *   listed. Google News RSS is deliberately absent: its terms allow personal,
 *   non-commercial use only. Gemini's Google Search grounding is absent for
 *   the same reason: its terms forbid storing or republishing grounded results.
 */

/** Phrases Australians begin a job search with. Each costs one request a week. */
export const SEARCH_SEEDS: readonly string[] = [
  'jobs hiring',
  'jobs in sydney',
  'jobs in melbourne',
  'jobs in brisbane',
  'jobs in perth',
  'jobs in adelaide',
  'part time jobs',
  'casual jobs',
  'work from home jobs',
  'remote jobs',
  'graduate jobs',
  'entry level jobs',
  'jobs with no experience',
  'jobs for international students',
  'highest paying jobs',
  'jobs that pay',
  'government jobs',
  'how to get a job',
  'how to write a resume',
  'cover letter for',
  'job interview questions',
  'skills shortage',
  'ai jobs',
  'jobs for',
];

export type SourceSpec =
  | {
      kind: 'feed';
      id: string;
      publisher: string;
      url: string;
      /** How many of the newest items to consider. */
      maxItems: number;
      /** Older items are not "latest" and are left out. */
      maxAgeDays: number;
      /** Where an item's text comes from: the feed's own full content, or the linked page. */
      text: 'feed' | 'page';
    }
  | {
      kind: 'page';
      id: string;
      publisher: string;
      /** A "latest release" address, which always points at the newest figures. */
      url: string;
      /** The excerpt starts at this heading, so navigation and boilerplate are skipped. */
      startAt: string;
    };

export const SOURCES: readonly SourceSpec[] = [
  {
    kind: 'page',
    id: 'abs-labour-force',
    publisher: 'Australian Bureau of Statistics',
    url: 'https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release',
    startAt: 'Key statistics',
  },
  {
    kind: 'page',
    id: 'abs-job-vacancies',
    publisher: 'Australian Bureau of Statistics',
    url: 'https://www.abs.gov.au/statistics/labour/jobs/job-vacancies-australia/latest-release',
    startAt: 'Key statistics',
  },
  {
    kind: 'page',
    id: 'abs-wage-price-index',
    publisher: 'Australian Bureau of Statistics',
    url: 'https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/wage-price-index-australia/latest-release',
    startAt: 'Key statistics',
  },
  {
    kind: 'feed',
    id: 'jsa-news',
    publisher: 'Jobs and Skills Australia',
    url: 'https://www.jobsandskills.gov.au/rss.xml',
    maxItems: 6,
    maxAgeDays: 21,
    text: 'page',
  },
  {
    kind: 'feed',
    id: 'indeed-hiring-lab-au',
    publisher: 'Indeed Hiring Lab Australia',
    url: 'https://www.hiringlab.org/au/feed/',
    maxItems: 4,
    maxAgeDays: 45,
    text: 'feed',
  },
];

/** The most one source contributes to the brief, so no single page crowds out the rest. */
export const EXCERPT_CHARS = 3_500;
