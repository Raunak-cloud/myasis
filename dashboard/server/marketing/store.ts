import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, one, query } from '../db/index.js';
import { readEnv } from '../runner.js';
import { isAdmin } from '../billing.js';
import type { MarketingJob, MarketingPost, MarketingSite, MarketingTopic, MarketingWorkspace } from '../../src/marketingTypes.js';
import { COUNTRIES, nextWeeklyRun, ownedLink, publicationProblem, topicKey, validateArticle, validateTimezone } from './policy.js';
import { assertPublicUrl, publicWebsiteUrl } from '../../../market-scout/src/core/public-url.js';
import { growthWorkspace } from './growth-store.js';

export function marketingOrigin(): string { try { return new URL(process.env.APP_BASE_URL ?? readEnv().APP_BASE_URL ?? 'https://owtomate.com').origin; } catch { return 'https://owtomate.com'; } }
export class MarketingError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export interface SiteRow extends Record<string, any> { id: string; user_id: string; url: string }
export interface JobRow extends Record<string, any> { id: string; user_id: string; site_id: string; kind: MarketingJob['kind']; topic_id: string | null; post_id: string | null; idempotency_key: string }
export const iso = (date: Date | string | null) => date ? new Date(date).toISOString() : null;

export function siteView(row: SiteRow): MarketingSite {
  return { id: row.id, url: row.url, name: row.name || new URL(row.url).hostname, country: row.country, profile: row.profile, research: row.research,
    voice: row.voice, audience: row.audience, ctaLabel: row.cta_label, ctaUrl: row.cta_url, profileConfirmed: row.profile_confirmed,
    publisher: row.publisher, scheduleEnabled: row.schedule_enabled, publishMode: row.publish_mode, scheduleDay: row.schedule_day,
    scheduleTime: row.schedule_time, timezone: row.timezone, nextRunAt: iso(row.next_run_at), ownsBlogSchedule: row.owns_blog_schedule,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, health:row.health || null };
}
export function topicView(row: Record<string, any>): MarketingTopic { return { id: row.id, title: row.title, keyword: row.keyword, angle: row.angle, intent: row.intent, priority: row.priority, rationale: row.rationale, productUrl: row.product_url, evidenceUrls: row.evidence_urls, basis: row.basis, status: row.status, createdAt: iso(row.created_at)! }; }
export function postView(row: Record<string, any>): MarketingPost { return { id: row.id, topicId: row.topic_id, status: row.status, article: row.article, sources: row.brief?.sources ?? [], quality: row.quality, model: row.model, publishedUrl: row.published_url, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, metrics: row.metrics }; }
export function jobView(row: Record<string, any>): MarketingJob { return { id: row.id, kind: row.kind, status: row.status, progress: row.progress, error: row.error, createdAt: iso(row.created_at)! }; }

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function ownedSite(userId: string, siteId: string): Promise<SiteRow> {
  const site = await one<SiteRow>('SELECT * FROM marketing_sites WHERE id=$1 AND user_id=$2', [siteId, userId]);
  if (!site) throw new MarketingError('Website not found.', 404);
  return site;
}
export async function workspace(userId: string, siteId: string, admin: boolean): Promise<MarketingWorkspace> {
  const row = await ownedSite(userId, siteId);
  const [topics, posts, jobs] = await Promise.all([
    query('SELECT * FROM marketing_topics WHERE site_id=$1 AND user_id=$2 ORDER BY CASE priority WHEN \'high\' THEN 0 ELSE 1 END, created_at, id', [siteId,userId]),
    query('SELECT * FROM marketing_posts WHERE site_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100', [siteId,userId]),
    query('SELECT * FROM marketing_jobs WHERE site_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20', [siteId,userId]),
  ]);
  const site=siteView(row);
  return { site, topics: topics.map(topicView), posts: posts.map(postView), jobs: jobs.map(jobView), canPublish: admin && row.publisher === 'owtomate',growth:await growthWorkspace(userId,siteId,site) };
}

export async function createSite(userId: string, admin: boolean, value: Record<string, unknown>): Promise<MarketingSite> {
  if (typeof value.url !== 'string') throw new MarketingError('Enter your website URL.');
  let url: string;
  try { url = publicWebsiteUrl(value.url.trim()); await assertPublicUrl(url); } catch { throw new MarketingError('Enter a reachable public HTTPS website. Private network addresses are not supported.'); }
  const country = typeof value.country === 'string' ? value.country : 'AU';
  if (!COUNTRIES.includes(country)) throw new MarketingError('Choose a supported research market.');
  const publisher = admin && new URL(url).origin === marketingOrigin() ? 'owtomate' : 'export';
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const existing = (await client.query('SELECT * FROM marketing_sites WHERE user_id=$1 AND url=$2', [userId,url])).rows[0];
    if (existing) return siteView(existing);
    const count = (await client.query('SELECT count(*)::int AS n FROM marketing_sites WHERE user_id=$1',[userId])).rows[0].n;
    if (count >= (admin ? 20 : 3)) throw new MarketingError('Your workspace has reached its website limit.', 429);
    if (publisher === 'owtomate' && (await client.query("SELECT 1 FROM marketing_sites WHERE publisher='owtomate' AND url=$1",[url])).rowCount) throw new MarketingError('Owtomate publishing is already managed by another admin workspace.',409);
    const id = randomUUID();
    const row = (await client.query('INSERT INTO marketing_sites(id,user_id,url,country,cta_url,publisher) VALUES($1,$2,$3,$4,$3,$5) RETURNING *',[id,userId,url,country,publisher])).rows[0];
    await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,idempotency_key) VALUES($1,$2,$3,'research',$4)",[randomUUID(),id,userId,`initial:${id}`]);
    return siteView(row);
  });
}

export async function updateSite(userId: string, siteId: string, admin: boolean, body: Record<string, unknown>): Promise<MarketingSite> {
  return transaction(async (client) => {
    const row = (await client.query('SELECT * FROM marketing_sites WHERE id=$1 AND user_id=$2 FOR UPDATE',[siteId,userId])).rows[0] as SiteRow | undefined;
    if (!row) throw new MarketingError('Website not found.',404);
    for (const [input, field, max] of [['name','name',120],['voice','voice',600],['audience','audience',1200],['ctaLabel','cta_label',100]] as const) {
      if (body[input] !== undefined) { if (typeof body[input] !== 'string' || (body[input] as string).length > max) throw new MarketingError(`Check ${input}.`); row[field] = (body[input] as string).trim(); }
    }
    if (body.ctaUrl !== undefined) { if (typeof body.ctaUrl !== 'string') throw new MarketingError('Enter your product link.'); row.cta_url = ownedLink(body.ctaUrl,row.url); }
    if (body.profileConfirmed !== undefined) { if (typeof body.profileConfirmed !== 'boolean') throw new MarketingError('Check profile confirmation.'); if (body.profileConfirmed && !row.profile?.pages?.length) throw new MarketingError('Complete the website scan first.'); row.profile_confirmed = body.profileConfirmed; }
    const fields:Record<string,string>={scheduleEnabled:'schedule_enabled',publishMode:'publish_mode',scheduleDay:'schedule_day',scheduleTime:'schedule_time',timezone:'timezone'};
    const scheduleChanged = Object.entries(fields).some(([input,field]) => body[input] !== undefined && body[input]!==row[field]);
    if (body.scheduleEnabled !== undefined) { if (typeof body.scheduleEnabled !== 'boolean') throw new MarketingError('Check the weekly schedule.'); row.schedule_enabled = body.scheduleEnabled; }
    if (body.publishMode !== undefined) { if (!['review','auto'].includes(String(body.publishMode))) throw new MarketingError('Choose draft review or automatic publishing.'); row.publish_mode = body.publishMode; }
    if (body.scheduleDay !== undefined) { if (!Number.isInteger(body.scheduleDay) || Number(body.scheduleDay) < 0 || Number(body.scheduleDay) > 6) throw new MarketingError('Choose a weekday.'); row.schedule_day = body.scheduleDay; }
    if (body.scheduleTime !== undefined) { if (typeof body.scheduleTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.scheduleTime)) throw new MarketingError('Choose a valid time.'); row.schedule_time = body.scheduleTime; }
    if (body.timezone !== undefined) { if (typeof body.timezone !== 'string') throw new MarketingError('Choose a timezone.'); row.timezone = validateTimezone(body.timezone); }
    if (row.schedule_enabled && !row.profile_confirmed) throw new MarketingError('Review and confirm the website profile before scheduling.');
    if (row.schedule_enabled && row.publish_mode === 'auto') { const problem = publicationProblem(siteView(row),admin,marketingOrigin()); if (problem) throw new MarketingError(problem); }
    if (row.schedule_enabled && row.publisher === 'owtomate') row.owns_blog_schedule = true;
    if (scheduleChanged) row.next_run_at = row.schedule_enabled ? nextWeeklyRun(new Date(),row.schedule_day,row.schedule_time,row.timezone) : null;
    const updated = (await client.query(`UPDATE marketing_sites SET name=$3,voice=$4,audience=$5,cta_label=$6,cta_url=$7,profile_confirmed=$8,
      schedule_enabled=$9,publish_mode=$10,schedule_day=$11,schedule_time=$12,timezone=$13,next_run_at=$14,owns_blog_schedule=$15,updated_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING *`, [siteId,userId,row.name,row.voice,row.audience,row.cta_label,row.cta_url,row.profile_confirmed,row.schedule_enabled,row.publish_mode,row.schedule_day,row.schedule_time,row.timezone,row.next_run_at,row.owns_blog_schedule])).rows[0];
    if (!row.schedule_enabled) await client.query("UPDATE marketing_jobs SET status='failed',error='Weekly schedule paused.',finished_at=now() WHERE site_id=$1 AND user_id=$2 AND kind='cycle' AND status='queued'",[siteId,userId]);
    return siteView(updated);
  });
}

export async function enqueue(userId: string, siteId: string, admin: boolean, kind: MarketingJob['kind'], topicId?: string, postId?: string): Promise<MarketingJob> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[userId]);
    const row = (await client.query('SELECT * FROM marketing_sites WHERE id=$1 AND user_id=$2 FOR UPDATE',[siteId,userId])).rows[0];
    if (!row) throw new MarketingError('Website not found.',404);
    if (!['research','health','visibility','results'].includes(kind) && !row.profile_confirmed) throw new MarketingError('Review and confirm the website profile first.');
    if ((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[siteId])).rowCount) throw new MarketingError('This website already has work in progress.',409);
    if (!admin) {
      const count = (await client.query("SELECT count(*)::int n FROM marketing_jobs WHERE user_id=$1 AND created_at>now()-interval '24 hours' AND kind=$2",[userId,kind])).rows[0].n;
      if (count >= (kind === 'research' ? 2 : 3)) throw new MarketingError('Daily beta limit reached. Try again tomorrow.',429);
    }
    if (kind === 'write') {
      const topic = (await client.query('SELECT status FROM marketing_topics WHERE id=$1 AND site_id=$2 AND user_id=$3',[topicId,siteId,userId])).rows[0];
      if (!topic || topic.status !== 'planned') throw new MarketingError('Choose a planned topic.',409);
      if (!row.research) throw new MarketingError('Research the website first.');
    }
    if (kind === 'review' || kind === 'publish') {
      const post = (await client.query('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3',[postId,siteId,userId])).rows[0];
      if (!post || post.status !== 'draft') throw new MarketingError('Choose an unpublished draft.',409);
      if (kind === 'publish') { const problem = publicationProblem(siteView(row),admin,marketingOrigin()); if (problem) throw new MarketingError(problem); if (!post.quality?.approved) throw new MarketingError('Run the draft quality review before publishing.'); }
    }
    const job = (await client.query('INSERT INTO marketing_jobs(id,site_id,user_id,kind,topic_id,post_id,idempotency_key) VALUES($1::uuid,$2,$3,$4,$5,$6,$1::uuid::text) RETURNING *',[randomUUID(),siteId,userId,kind,topicId || null,postId || null])).rows[0];
    return jobView(job);
  });
}

export async function saveDraft(userId: string, siteId: string, postId: string, body: Record<string, unknown>): Promise<MarketingPost> {
  return transaction(async (client) => {
    await client.query('SELECT id FROM marketing_sites WHERE id=$1 AND user_id=$2 FOR UPDATE',[siteId,userId]);
    if ((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[siteId])).rowCount) throw new MarketingError('Wait for the current job before editing.',409);
    const row = (await client.query('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3 FOR UPDATE',[postId,siteId,userId])).rows[0];
    if (!row || row.status !== 'draft') throw new MarketingError('Unpublished draft not found.',404);
    if (body.updatedAt !== iso(row.updated_at)) throw new MarketingError('This draft changed. Reload before saving.',409);
    const article = validateArticle(body.article,(row.brief?.sources ?? []).map((s: {ref:string}) => s.ref));
    const updated = (await client.query("UPDATE marketing_posts SET article=$4,quality=$5,article_hash=NULL,updated_at=now() WHERE id=$1 AND site_id=$2 AND user_id=$3 RETURNING *",[postId,siteId,userId,article,{approved:false,issues:['Edited draft needs a new source review.'],reviewedAt:null}])).rows[0];
    return postView(updated);
  });
}

export async function setTopicStatus(userId: string, siteId: string, topicId: string, status: unknown): Promise<void> {
  if (status !== 'planned' && status !== 'dismissed') throw new MarketingError('Choose a valid topic status.');
  const row = await one("UPDATE marketing_topics SET status=$4 WHERE id=$1 AND site_id=$2 AND user_id=$3 AND status IN ('planned','dismissed') RETURNING id",[topicId,siteId,userId,status]);
  if (!row) throw new MarketingError('This topic cannot be changed.',409);
}

export async function addTopic(userId: string, siteId: string, body: Record<string, unknown>): Promise<void> {
  const site = await ownedSite(userId,siteId);
  const text = (key: string, max: number) => typeof body[key] === 'string' ? (body[key] as string).trim().slice(0,max) : '';
  const title = text('title',160), keyword = text('keyword',120);
  if (!title || !keyword) throw new MarketingError('Enter a title and focus topic.');
  const existing = await one('SELECT 1 FROM marketing_topics WHERE site_id=$1 AND topic_key=$2',[siteId,topicKey(keyword)]);
  if (existing) throw new MarketingError('This focus topic already has a plan or post.',409);
  const count = await one<{n:number}>('SELECT count(*)::int n FROM marketing_topics WHERE site_id=$1',[siteId]);
  if ((count?.n ?? 0) >= 100) throw new MarketingError('This website has reached its topic limit.',429);
  await query("INSERT INTO marketing_topics(id,site_id,user_id,topic_key,title,keyword,angle,intent,priority,rationale,product_url,basis) VALUES($1,$2,$3,$4,$5,$6,$7,'learn','medium','Your idea; search demand is unmeasured.',$8,'custom')",[randomUUID(),siteId,userId,topicKey(keyword),title,keyword,text('angle',800) || 'Answer the reader question with helpful product information.',site.cta_url]);
}

export async function saveMetrics(userId: string, siteId: string, postId: string, body: Record<string, unknown>): Promise<void> {
  const date = (name: string) => {const v=body[name];return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v?v:null;};
  const periodStart = date('periodStart'), periodEnd = date('periodEnd');
  if (!periodStart || !periodEnd || periodEnd < periodStart || periodEnd > new Date().toISOString().slice(0,10)) throw new MarketingError('Choose a completed measurement period.');
  const metric = (key: string, integer: boolean) => { const v = body[key]; if (v == null || v === '') return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9 || (integer && !Number.isInteger(v))) throw new MarketingError(`Check ${key}.`); return v; };
  const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : 'AUD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new MarketingError('Use a three-letter currency.');
  const metrics = {periodStart,periodEnd,visits:metric('visits',true),leads:metric('leads',true),orders:metric('orders',true),revenue:metric('revenue',false),currency,notes:typeof body.notes==='string'?body.notes.slice(0,600):'',recordedAt:new Date().toISOString()};
  const updated = await one("UPDATE marketing_posts SET metrics=$4 WHERE id=$1 AND site_id=$2 AND user_id=$3 AND status='published' RETURNING id",[postId,siteId,userId,metrics]);
  if (!updated) throw new MarketingError('Published post not found.',404);
}

export async function ownerIsAdmin(userId: string): Promise<boolean> { const owner = await one<{email:string}>('SELECT email FROM users WHERE id=$1',[userId]); return isAdmin(owner?.email); }
