import { XMLParser } from 'fast-xml-parser';
import { query } from '../db/index.js';
import { EXCERPT_CHARS, SEARCH_SEEDS, SOURCES, type SourceSpec } from './sources.js';

/**
 * Everything the weekly post may say, gathered before a word is written.
 *
 * The article is only as good as its facts, so the facts are collected by
 * code from named places and handed to the model as a brief. The model
 * writes from the brief and cites it; it never goes looking on its own.
 * That keeps every claim traceable to a source a reader can open.
 */

export interface SearchSuggestion {
  seed: string;
  suggestion: string;
  /** Google's own order, 1 = most searched among those it shows. */
  rank: number;
  /** Not among the suggestions for this seed last week. */
  isNew: boolean;
}

export interface BriefSource {
  /** Stable within one brief: S1, S2, … — what the article cites. */
  ref: string;
  publisher: string;
  title: string;
  url: string;
  /** ISO date, when the publisher gives one. */
  published: string | null;
  excerpt: string;
}

export interface ListingSample {
  /** Distinct listings Owtomate reviewed for its users in the week. */
  listings: number;
  topTitles: Array<{ title: string; listings: number }>;
  /** Share of listings that sent the applicant to the employer's own site. */
  employerSiteShare: number;
  workArrangements: Array<{ arrangement: string; applications: number }>;
}

export interface Brief {
  /** The Monday the post is published for, YYYY-MM-DD in the run time zone. */
  week: string;
  gatheredAt: string;
  searches: SearchSuggestion[];
  sources: BriefSource[];
  /** Null when the week's sample is too small to say anything about. */
  listingSample: ListingSample | null;
  /** Sources that could not be read this week, for the operator. */
  unavailable: string[];
}

/**
 * A browser's string with our name on the end. Government sites behind a WAF
 * (jobsandskills.gov.au) silently hang any request whose agent looks like a
 * crawler's, including an honest "compatible; Owtomate" one.
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Owtomate/1.0';
const FETCH_TIMEOUT_MS = 20_000;
/** Autocomplete is a public endpoint; a pause between seeds keeps us a polite caller. */
const SEED_PAUSE_MS = 1_200;
/** Below this, a week of Owtomate's own listings is anecdote, not a sample. */
const MIN_LISTINGS = 150;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', dollar: '$', percnt: '%',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Readable text from a page, for the model to read — never shown to anyone.
 * Chrome (navigation, scripts, forms) is dropped; block elements become line
 * breaks so tables and lists stay legible.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol|tr|table|br|dd|dt|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[\s|]*/g, '\n')
    .trim();
}

/** The main content of an article page: <article>, then <main>, then the body. */
function mainContent(html: string): string {
  const pick = (tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, 'i'))?.[1];
  return htmlToText(pick('article') ?? pick('main') ?? pick('body') ?? html);
}

function clip(text: string, limit = EXCERPT_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('. ', limit);
  return `${text.slice(0, cut > limit * 0.6 ? cut + 1 : limit).trim()} …`;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** "Released 19/08/2026" on an ABS release page. */
function releasedOn(html: string): string | null {
  const match = htmlToText(html).match(/Released\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : null;
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

/** Google's autocomplete for one phrase, as seen from Australia. */
async function suggestionsFor(seed: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en-AU&gl=au&q=${encodeURIComponent(`${seed} `)}`;
  const body = JSON.parse(await fetchText(url)) as [string, unknown];
  const list = Array.isArray(body?.[1]) ? body[1] : [];
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== seed);
}

async function gatherSearches(week: string, unavailable: string[]): Promise<SearchSuggestion[]> {
  const previous = await query<{ seed: string; suggestion: string }>(
    `SELECT seed, suggestion FROM search_suggestions
      WHERE week = (SELECT max(week) FROM search_suggestions WHERE week < $1::date)`,
    [week],
  );
  const seenBefore = new Set(previous.map((row) => `${row.seed}\n${row.suggestion}`));
  const hadHistory = previous.length > 0;

  const searches: SearchSuggestion[] = [];
  for (const seed of SEARCH_SEEDS) {
    try {
      const list = await suggestionsFor(seed);
      list.forEach((suggestion, index) => searches.push({
        seed,
        suggestion,
        rank: index + 1,
        // With no earlier week to compare, nothing can honestly be called new.
        isNew: hadHistory && !seenBefore.has(`${seed}\n${suggestion}`),
      }));
    } catch (error) {
      unavailable.push(`Google autocomplete "${seed}": ${(error as Error).message}`);
    }
    await pause(SEED_PAUSE_MS);
  }

  // Kept per week so next week can tell what is new; rerunning a week replaces its snapshot.
  if (searches.length) {
    await query('DELETE FROM search_suggestions WHERE week = $1::date', [week]);
    await query(
      `INSERT INTO search_suggestions (week, seed, suggestion, rank)
       SELECT $1::date, s.seed, s.suggestion, s.rank
         FROM unnest($2::text[], $3::text[], $4::int[]) AS s(seed, suggestion, rank)
       ON CONFLICT DO NOTHING`,
      [week, searches.map((s) => s.seed), searches.map((s) => s.suggestion), searches.map((s) => s.rank)],
    );
  }
  return searches;
}

// ---------------------------------------------------------------------------
// Published sources
// ---------------------------------------------------------------------------

const xml = new XMLParser({ ignoreAttributes: false, htmlEntities: true, cdataPropName: false });

interface FeedItem { title: string; link: string; published: string | null; content: string }

function feedItems(body: string): FeedItem[] {
  const doc = xml.parse(body) as any;
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'object' && value && '#text' in value ? String((value as any)['#text']) : '';
  return items.map((item: any) => ({
    title: htmlToText(text(item.title)),
    link: typeof item.link === 'string' ? item.link : item.link?.['@_href'] ?? '',
    published: isoDate(item.pubDate ?? item.published ?? item.updated ?? item['dc:date']),
    content: text(item['content:encoded'] ?? item.content ?? item.description ?? item.summary),
  })).filter((item) => item.title && item.link);
}

async function readSource(spec: SourceSpec, now: Date): Promise<Omit<BriefSource, 'ref'>[]> {
  if (spec.kind === 'page') {
    const html = await fetchText(spec.url);
    const text = htmlToText(html);
    const start = text.indexOf(spec.startAt);
    if (start < 0) throw new Error(`no "${spec.startAt}" section`);
    const title = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s*\|.*$/, '').trim();
    return [{ publisher: spec.publisher, title: title || spec.publisher, url: spec.url, published: releasedOn(html), excerpt: clip(text.slice(start)) }];
  }

  const oldest = now.getTime() - spec.maxAgeDays * 86_400_000;
  const items = feedItems(await fetchText(spec.url))
    .filter((item) => !item.published || Date.parse(item.published) >= oldest)
    .slice(0, spec.maxItems);

  const read: Omit<BriefSource, 'ref'>[] = [];
  for (const item of items) {
    let body = htmlToText(item.content);
    if (spec.text === 'page') body = await fetchText(item.link).then(mainContent).catch(() => body);
    if (!body) continue;
    read.push({ publisher: spec.publisher, title: item.title, url: item.link, published: item.published, excerpt: clip(body) });
  }
  return read;
}

async function gatherSources(now: Date, unavailable: string[]): Promise<BriefSource[]> {
  const settled = await Promise.allSettled(SOURCES.map((spec) => readSource(spec, now)));
  const sources: Omit<BriefSource, 'ref'>[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') sources.push(...result.value);
    else unavailable.push(`${SOURCES[index].publisher} (${SOURCES[index].id}): ${(result.reason as Error).message}`);
  });
  return sources.map((source, index) => ({ ref: `S${index + 1}`, ...source }));
}

// ---------------------------------------------------------------------------
// Owtomate's own listings
// ---------------------------------------------------------------------------

/**
 * What the week's runs saw, aggregated across every account. Only listing
 * titles and counts leave this function — never a user, company or résumé —
 * and a title only one account saw is dropped, so no single person's search shows.
 */
async function gatherListingSample(): Promise<ListingSample | null> {
  const window = `ts >= now() - interval '7 days' AND job_id IS NOT NULL AND title IS NOT NULL`;
  const [totals, titles, arrangements] = await Promise.all([
    query<{ listings: string; employer_site: string }>(
      `SELECT count(DISTINCT job_id)::text AS listings,
              count(DISTINCT job_id) FILTER (WHERE status = 'off-platform')::text AS employer_site
         FROM run_events WHERE ${window}`,
    ),
    query<{ title: string; listings: string }>(
      `SELECT lower(btrim(title)) AS title, count(DISTINCT job_id)::text AS listings
         FROM run_events WHERE ${window}
        GROUP BY 1 HAVING count(DISTINCT user_id) > 1
        ORDER BY count(DISTINCT job_id) DESC LIMIT 20`,
    ),
    query<{ arrangement: string; applications: string }>(
      `SELECT coalesce(nullif(lower(btrim(work_arrangement)), ''), 'not stated') AS arrangement, count(*)::text AS applications
         FROM applications WHERE applied_at >= now() - interval '7 days'
        GROUP BY 1 ORDER BY count(*) DESC`,
    ),
  ]);
  const listings = Number(totals[0]?.listings ?? 0);
  if (listings < MIN_LISTINGS) return null;
  return {
    listings,
    topTitles: titles.map((row) => ({ title: row.title, listings: Number(row.listings) })),
    employerSiteShare: Math.round((Number(totals[0]?.employer_site ?? 0) / listings) * 100) / 100,
    workArrangements: arrangements.map((row) => ({ arrangement: row.arrangement, applications: Number(row.applications) })),
  };
}

export async function gatherBrief(week: string, now: Date = new Date()): Promise<Brief> {
  const unavailable: string[] = [];
  const [searches, sources, listingSample] = await Promise.all([
    gatherSearches(week, unavailable),
    gatherSources(now, unavailable),
    gatherListingSample().catch((error) => {
      unavailable.push(`Owtomate listings: ${(error as Error).message}`);
      return null;
    }),
  ]);
  return { week, gatheredAt: now.toISOString(), searches, sources, listingSample, unavailable };
}
