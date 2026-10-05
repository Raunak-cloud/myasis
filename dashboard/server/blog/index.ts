import { Resend } from 'resend';
import { one, query } from '../db/index.js';
import { adminAddresses } from '../billing.js';
import { digestConfig } from '../digest.js';
import { RUN_TIME_ZONE } from '../entitlements.js';
import { readEnv } from '../runner.js';
import { writerConfig } from './models.js';
import { postPath, type PostSummary, type StoredPost } from './render.js';
import { gatherBrief, type Brief } from './signals.js';
import { writePost, type Article } from './writer.js';

/**
 * The weekly job-market brief: when it is written, where it is kept, and
 * what the operator hears about it.
 *
 * Each week is keyed by its Monday in the run time zone. From 06:00 that
 * Monday the week is due; a tick finds it has no post, gathers the brief,
 * writes, fact-checks and stores it — and storing is publishing. A restart,
 * a late deploy or a failed try does not lose the week: the next tick picks
 * it up, a few hours apart, up to MAX_ATTEMPTS. The operator is emailed the
 * link when a post goes up, and the reason when a week gives up.
 */

const PUBLISH_HOUR = 6;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_HOURS = 3;
const TICK_MS = 15 * 60_000;
const RECENT_FOR_CONTEXT = 8;

function blogEnabled(): boolean {
  return (process.env.BLOG_WEEKLY ?? readEnv().BLOG_WEEKLY ?? 'true').trim() !== 'false';
}

export function siteOrigin(): string {
  const configured = (process.env.APP_BASE_URL ?? readEnv().APP_BASE_URL ?? '').trim();
  try {
    return new URL(configured).origin;
  } catch {
    return 'https://owtomate.com';
  }
}

/** The local calendar in the run time zone. */
function localParts(at: Date): { date: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: RUN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) };
}

/** The Monday of the week `at` falls in, and whether that week's post is due yet. */
export function weekOf(at: Date = new Date()): { week: string; due: boolean } {
  const local = localParts(at);
  const monday = new Date(`${local.date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (local.weekday - 1));
  return { week: monday.toISOString().slice(0, 10), due: local.weekday > 1 || local.hour >= PUBLISH_HOUR };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface PostRow {
  slug: string;
  title: string;
  description: string;
  article: Article;
  brief: Brief;
  published_at: Date;
  updated_at: Date;
}

export async function publishedPosts(): Promise<PostSummary[]> {
  const rows = await query<Omit<PostRow, 'article' | 'brief'>>(
    `SELECT slug, title, description, published_at, updated_at FROM blog_posts
      WHERE hidden_at IS NULL ORDER BY published_at DESC`,
  );
  return rows.map((row) => ({ slug: row.slug, title: row.title, description: row.description, publishedAt: row.published_at, updatedAt: row.updated_at }));
}

export async function publishedPost(slug: string): Promise<StoredPost | null> {
  const row = await one<PostRow>(
    `SELECT slug, title, description, article, brief, published_at, updated_at FROM blog_posts
      WHERE slug = $1 AND hidden_at IS NULL`,
    [slug],
  );
  return row && { slug: row.slug, title: row.title, description: row.description, article: row.article, brief: row.brief, publishedAt: row.published_at, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 10).join('-');
}

/** Extra posts can share a week and an initial slug, but never an address. */
async function freeSlug(wanted: string, week: string): Promise<string> {
  const base = slugify(wanted) || `australian-job-market-${week}`;
  let slug = base;
  for (let suffix = 1; await one('SELECT 1 FROM blog_posts WHERE slug = $1', [slug]); suffix++) {
    slug = `${base}-${week}${suffix > 1 ? `-${suffix}` : ''}`;
  }
  return slug;
}

let writing: Promise<PublishResult> | null = null;

export function isBlogWriting(): boolean {
  return Boolean(writing);
}

export type PublishResult =
  | { ok: true; week: string; slug: string; title: string; url: string }
  | { ok: false; week: string; error: string };

/**
 * Writes and publishes one week's post. With `replace`, a week that already
 * has one is rewritten in place — same address, so links to it keep working.
 * With `additional`, a separate post is written through the same pipeline.
 * Only one runs at a time; concurrent requests are rejected.
 */
export function publishWeek(week: string, options: { replace?: boolean; additional?: boolean } = {}): Promise<PublishResult> {
  if (writing) return Promise.resolve({ ok: false, week, error: 'A post is already being written.' });
  if (options.replace && options.additional) return Promise.resolve({ ok: false, week, error: 'Choose either rewrite or add another blog.' });
  writing = (async (): Promise<PublishResult> => {
    const config = writerConfig();
    if (!config) return { ok: false, week, error: 'Add a Gemini API key under Config → Weekly blog first.' };
    const existing = options.additional ? null : await one<{ slug: string }>("SELECT slug FROM blog_posts WHERE week = $1::date AND kind = 'weekly'", [week]);
    if (existing && !options.replace) return { ok: false, week, error: 'This week already has a post.' };
    // Manual extra posts must not exhaust the scheduler's weekly retry budget.
    const attemptsTable = options.additional ? 'blog_extra_attempts' : 'blog_attempts';

    await query(
      `INSERT INTO ${attemptsTable} (week, attempts, last_attempt_at) VALUES ($1::date, 1, now())
       ON CONFLICT (week) DO UPDATE SET attempts = ${attemptsTable}.attempts + 1, last_attempt_at = now()`,
      [week],
    );
    try {
      const brief = await gatherBrief(week);
      const recent = await query<{ title: string }>(
        'SELECT title FROM blog_posts ORDER BY published_at DESC LIMIT $1',
        [RECENT_FOR_CONTEXT],
      );
      const written = await writePost(brief, recent.map((row) => row.title), config);
      const slug = existing?.slug ?? await freeSlug(written.article.slug || written.article.title, week);
      await query(
        `INSERT INTO blog_posts (week, slug, title, description, article, brief, model, revisions, kind)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (week) WHERE kind = 'weekly' DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description, article = EXCLUDED.article,
           brief = EXCLUDED.brief, model = EXCLUDED.model, revisions = EXCLUDED.revisions, updated_at = now()`,
        [week, slug, written.article.title, written.article.metaDescription, written.article, brief, written.model, JSON.stringify(written.revisions), options.additional ? 'extra' : 'weekly'],
      );
      await query(`UPDATE ${attemptsTable} SET last_error = NULL WHERE week = $1::date`, [week]);
      const url = `${siteOrigin()}${postPath(slug)}`;
      if (brief.unavailable.length) console.warn(`[blog] ${week}: written without ${brief.unavailable.join('; ')}`);
      console.log(`[blog] ${week}: published ${url} (${written.revisions.length} revision(s))`);
      return { ok: true, week, slug, title: written.article.title, url };
    } catch (error) {
      const message = (error as Error).message;
      await query(`UPDATE ${attemptsTable} SET last_error = $2 WHERE week = $1::date`, [week, message.slice(0, 2_000)]);
      console.warn(`[blog] ${week}: ${message}`);
      return { ok: false, week, error: message };
    }
  })().catch((error): PublishResult => {
    // Configuration/database failures before research must also settle the job.
    const message = (error as Error).message;
    console.warn(`[blog] ${week}: ${message}`);
    return { ok: false, week, error: message };
  }).finally(() => { writing = null; });
  return writing;
}

async function tellOperator(subject: string, paragraphs: string[]): Promise<void> {
  const config = digestConfig();
  const recipients = adminAddresses();
  if (!config || !recipients.length) return;
  const text = [...paragraphs, `Admin dashboard: ${config.dashboardUrl.replace(/\/+$/, '')}/?tab=admin`].join('\n\n');
  const result = await new Resend(config.apiKey).emails.send({ from: config.from, to: recipients, subject: `[Owtomate blog] ${subject}`, text });
  if (result.error) throw new Error(result.error.message);
}

/** One pass of the scheduler: publish the current week if it is due and not yet done. */
async function blogTick(now: Date = new Date()): Promise<PublishResult | null> {
  if (!blogEnabled() || !writerConfig()) return null;
  const { week, due } = weekOf(now);
  if (!due) return null;
  if (await one("SELECT 1 FROM blog_posts WHERE week = $1::date AND kind = 'weekly'", [week])) return null;
  const tried = await one<{ attempts: number; last_attempt_at: Date | null }>(
    'SELECT attempts, last_attempt_at FROM blog_attempts WHERE week = $1::date',
    [week],
  );
  if (tried && tried.attempts >= MAX_ATTEMPTS) return null;
  if (tried?.last_attempt_at && now.getTime() - tried.last_attempt_at.getTime() < RETRY_AFTER_HOURS * 3_600_000) return null;

  const result = await publishWeek(week);
  const attempts = (tried?.attempts ?? 0) + 1;
  if (result.ok) {
    await tellOperator(`Published: ${result.title}`, [
      `This week's brief is live: ${result.url}`,
      'Read it. If anything is wrong, hide it or rewrite it from Admin → Blog.',
    ]).catch((error) => console.warn('[blog] operator email failed:', (error as Error).message));
  } else if (attempts >= MAX_ATTEMPTS) {
    await tellOperator(`No post for the week of ${week}`, [
      `The weekly brief failed ${attempts} times and will not be tried again this week.`,
      `Last error: ${result.error}`,
      'Fix the cause, then use Write now in Admin → Blog.',
    ]).catch((error) => console.warn('[blog] operator email failed:', (error as Error).message));
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startBlogScheduler(): void {
  if (timer) return;
  const tick = () => void blogTick().catch((error) => console.warn('[blog] tick failed:', (error as Error).message));
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface BlogReport {
  enabled: boolean;
  configured: boolean;
  model: string | null;
  currentWeek: string;
  writing: boolean;
  posts: Array<{ id: string; kind: 'weekly' | 'extra'; week: string; slug: string; title: string; url: string; hidden: boolean; publishedAt: string; updatedAt: string; revisions: number; unavailable: string[] }>;
  attempts: Array<{ kind: 'weekly' | 'extra'; week: string; attempts: number; lastAttemptAt: string | null; lastError: string | null }>;
}

export async function blogReport(): Promise<BlogReport> {
  const [posts, attempts] = await Promise.all([
    query<{ id: string; kind: 'weekly' | 'extra'; week: string; slug: string; title: string; hidden: boolean; published_at: Date; updated_at: Date; revisions: number; unavailable: string[] | null }>(
      `SELECT id::text, kind, week::text, slug, title, hidden_at IS NOT NULL AS hidden, published_at, updated_at,
              jsonb_array_length(revisions) AS revisions,
              ARRAY(SELECT jsonb_array_elements_text(brief->'unavailable')) AS unavailable
         FROM blog_posts ORDER BY published_at DESC LIMIT 100`,
    ),
    query<{ kind: 'weekly' | 'extra'; week: string; attempts: number; last_attempt_at: Date | null; last_error: string | null }>(
      `SELECT 'weekly' AS kind, week::text, attempts, last_attempt_at, last_error FROM blog_attempts
       UNION ALL
       SELECT 'extra' AS kind, week::text, attempts, last_attempt_at, last_error FROM blog_extra_attempts
       ORDER BY last_attempt_at DESC NULLS LAST LIMIT 16`,
    ),
  ]);
  const config = writerConfig();
  const origin = siteOrigin();
  return {
    enabled: blogEnabled(),
    configured: Boolean(config),
    model: config?.model ?? null,
    currentWeek: weekOf().week,
    writing: isBlogWriting(),
    posts: posts.map((p) => ({
      id: p.id, kind: p.kind, week: p.week, slug: p.slug, title: p.title, url: `${origin}${postPath(p.slug)}`, hidden: p.hidden,
      publishedAt: p.published_at.toISOString(), updatedAt: p.updated_at.toISOString(), revisions: p.revisions, unavailable: p.unavailable ?? [],
    })),
    attempts: attempts.map((a) => ({ kind: a.kind, week: a.week, attempts: a.attempts, lastAttemptAt: a.last_attempt_at?.toISOString() ?? null, lastError: a.last_error })),
  };
}

export async function setPostHidden(id: string, hidden: boolean): Promise<boolean> {
  const rows = await query(
    `UPDATE blog_posts SET hidden_at = CASE WHEN $2 THEN coalesce(hidden_at, now()) ELSE NULL END WHERE id = $1::bigint RETURNING id`,
    [id, hidden],
  );
  return rows.length > 0;
}
