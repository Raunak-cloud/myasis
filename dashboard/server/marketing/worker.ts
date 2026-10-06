import { randomUUID } from 'node:crypto';
import { getPool, one, query } from '../db/index.js';
import { deploying } from '../runner.js';
import { readWebsite, researchWebsite, stopMarketingBrowsers } from './scout.js';
import { planContent, reviewContent, writeContent } from './content.js';
import { articleHash, nextWeeklyRun, publicationProblem, topicKey, validateArticle } from './policy.js';
import { MarketingError, marketingOrigin, ownedSite, ownerIsAdmin, siteView, topicView, transaction, type JobRow } from './store.js';

let timer: ReturnType<typeof setInterval> | undefined;
let busy=false, stopping=false;
const progress = async (job: JobRow, text: string) => { await query('UPDATE marketing_jobs SET progress=$2,heartbeat_at=now() WHERE id=$1',[job.id,text]); };

async function titles(siteId: string, internal: boolean) {
  const rows = await query<{title:string}>('SELECT title FROM marketing_topics WHERE site_id=$1',[siteId]);
  if (internal) rows.push(...await query<{title:string}>('SELECT title FROM blog_posts'));
  return rows.map(r=>r.title);
}

async function research(job: JobRow) {
  const before=siteView(await ownedSite(job.user_id,job.site_id));
  await progress(job,'Reading public product and service pages…');
  const profile=await readWebsite(before,job.user_id);
  await progress(job,'Finding competitors and buyer questions in the browser…');
  const snapshot=await researchWebsite(before,job.user_id,profile);
  // A changed product description needs another human confirmation.
  await query(`UPDATE marketing_sites SET profile=$3,research=$4,name=CASE WHEN name='' THEN $5 ELSE name END,
    profile_confirmed=CASE WHEN profile->>'sells'=$6 THEN profile_confirmed ELSE false END,updated_at=now()
    WHERE id=$1 AND user_id=$2`,[job.site_id,job.user_id,profile,snapshot,profile.name,profile.sells]);
  await progress(job,'Building a useful, evidence-linked content plan…');
  const site=siteView(await ownedSite(job.user_id,job.site_id));
  const topics=await planContent(site,profile,snapshot,await titles(site.id,site.publisher==='owtomate'));
  await transaction(async client=>{
    await client.query('SELECT id FROM marketing_sites WHERE id=$1 FOR UPDATE',[site.id]);
    const count=Number((await client.query('SELECT count(*) n FROM marketing_topics WHERE site_id=$1',[site.id])).rows[0].n);
    for(const t of topics.slice(0,Math.max(0,100-count))) await client.query(`INSERT INTO marketing_topics(id,site_id,user_id,topic_key,title,keyword,angle,intent,priority,rationale,product_url,evidence_urls,basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(site_id,topic_key) DO NOTHING`,[t.id,site.id,job.user_id,topicKey(t.keyword),t.title,t.keyword,t.angle,t.intent,t.priority,t.rationale,t.productUrl,JSON.stringify(t.evidenceUrls),t.basis]);
  });
}

async function write(job: JobRow) {
  const site=siteView(await ownedSite(job.user_id,job.site_id));
  if(!site.profileConfirmed) throw new MarketingError('Review and confirm the website profile first.');
  const row=await one('SELECT * FROM marketing_topics WHERE id=$1 AND site_id=$2 AND user_id=$3',[job.topic_id,job.site_id,job.user_id]);
  if(!row || row.status==='dismissed') throw new MarketingError('Choose a planned topic.');
  const topic=topicView(row);
  const post=await transaction(async client=>{
    const existing=(await client.query('SELECT * FROM marketing_posts WHERE topic_id=$1 AND site_id=$2 FOR UPDATE',[topic.id,site.id])).rows[0];
    if(existing?.status==='published' || existing?.status==='draft') return existing;
    const id=existing?.id ?? randomUUID();
    const saved=(await client.query(`INSERT INTO marketing_posts(id,site_id,user_id,topic_id,status) VALUES($1,$2,$3,$4,'writing')
      ON CONFLICT(topic_id) DO UPDATE SET status='writing',updated_at=now() RETURNING *`,[id,site.id,job.user_id,topic.id])).rows[0];
    await client.query("UPDATE marketing_topics SET status='writing' WHERE id=$1 AND site_id=$2",[topic.id,site.id]);
    return saved;
  });
  job.post_id=post.id;
  await query('UPDATE marketing_jobs SET post_id=$2 WHERE id=$1',[job.id,post.id]);
  if(post.status==='draft' || post.status==='published') return;
  await progress(job,'Gemini is writing and checking the draft against its sources…');
  const existing=await query<{title:string}>("SELECT article->>'title' title FROM marketing_posts WHERE site_id=$1 AND id<>$2 AND status IN ('draft','published')",[site.id,post.id]);
  if(site.publisher==='owtomate') existing.push(...await query<{title:string}>('SELECT title FROM blog_posts'));
  const result=await writeContent(site,topic,existing.map(r=>r.title));
  await transaction(async client=>{
    await client.query("UPDATE marketing_posts SET status='draft',article=$2,brief=$3,quality=$4,model=$5,article_hash=$6,updated_at=now() WHERE id=$1",[post.id,result.article,result.brief,result.quality,result.model,articleHash(result.article)]);
    await client.query("UPDATE marketing_topics SET status='drafted' WHERE id=$1 AND site_id=$2",[topic.id,site.id]);
  });
}

async function review(job: JobRow) {
  const post=await one('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3',[job.post_id,job.site_id,job.user_id]);
  if(!post || post.status!=='draft') throw new MarketingError('Unpublished draft not found.');
  await progress(job,'Checking every factual claim against the saved sources…');
  const quality=await reviewContent(post.article,post.brief);
  const saved=await query("UPDATE marketing_posts SET quality=$4,article_hash=$5,updated_at=now() WHERE id=$1 AND site_id=$2 AND user_id=$3 AND status='draft' AND article=$6::jsonb RETURNING id",[post.id,job.site_id,job.user_id,quality,articleHash(post.article),post.article]);
  if(!saved.length) throw new MarketingError('The draft changed during review. Review it again.');
  return quality;
}

export function publicationSourceProblem(brief: {gatheredAt?:string;sources?:Array<{collectedAt?:string}>}, now=Date.now()): string | null {
  const dates=[brief.gatheredAt,...(brief.sources || []).map(s=>s.collectedAt)];
  if(!brief.sources?.length || dates.some(d=>!d || !Number.isFinite(Date.parse(d)) || Date.parse(d)>now+60_000 || now-Date.parse(d)>7*86400_000)) return 'This draft has old or incomplete sources. Refresh research and create a new draft.';
  return null;
}

async function publish(job: JobRow, scheduled=false) {
  let site=siteView(await ownedSite(job.user_id,job.site_id));
  const problem=publicationProblem(site,await ownerIsAdmin(job.user_id),marketingOrigin());
  if(problem) throw new MarketingError(problem);
  const post=await one('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3',[job.post_id,job.site_id,job.user_id]);
  if(!post) throw new MarketingError('Draft not found.');
  if(post.status==='published') return;
  const stale=publicationSourceProblem(post.brief || {}); if(stale) throw new MarketingError(stale);
  const quality=await review(job);
  if(!quality?.approved) throw new MarketingError('Publication stopped: the source review needs attention. Open the draft to see the issues.');
  await transaction(async client=>{
    const row=(await client.query('SELECT * FROM marketing_sites WHERE id=$1 AND user_id=$2 FOR UPDATE',[job.site_id,job.user_id])).rows[0];
    site=siteView(row);
    if(scheduled && (!site.scheduleEnabled || site.publishMode!=='auto')) return;
    const finalProblem=publicationProblem(site,await ownerIsAdmin(job.user_id),marketingOrigin()); if(finalProblem) throw new MarketingError(finalProblem);
    const current=(await client.query('SELECT * FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3 FOR UPDATE',[job.post_id,job.site_id,job.user_id])).rows[0];
    if(current.status==='published') return;
    const article=validateArticle(current.article,current.brief.sources.map((s:{ref:string})=>s.ref));
    if(!current.quality?.approved || current.article_hash!==articleHash(article)) throw new MarketingError('The draft changed after its review. Review it again.');
    const sourceProblem=publicationSourceProblem(current.brief); if(sourceProblem) throw new MarketingError(sourceProblem);
    const slug=`${article.slug}-${current.id.slice(0,8)}`;
    const blog=(await client.query(`INSERT INTO blog_posts(week,kind,slug,title,description,article,brief,model) VALUES($1,'extra',$2,$3,$4,$5,$6,$7) RETURNING id`,[current.brief.week,slug,article.title,article.metaDescription,article,current.brief,current.model])).rows[0];
    await client.query("UPDATE marketing_posts SET status='published',blog_post_id=$2,published_url=$3,updated_at=now() WHERE id=$1",[current.id,blog.id,`${marketingOrigin()}/blog/${slug}`]);
    await client.query("UPDATE marketing_topics SET status='published' WHERE id=$1 AND site_id=$2",[current.topic_id,job.site_id]);
  });
}

async function execute(job: JobRow) {
  if(job.kind==='research') return research(job);
  if(job.kind==='write') return write(job);
  if(job.kind==='review') {await review(job);return;}
  if(job.kind==='publish') return publish(job);
  let site=siteView(await ownedSite(job.user_id,job.site_id));
  if(!site.scheduleEnabled) throw new MarketingError('Weekly schedule paused.');
  if(!job.topic_id) {
    if(!site.research || Date.now()-Date.parse(site.research.researchedAt)>6*86400_000) {await research(job);site=siteView(await ownedSite(job.user_id,job.site_id));}
    const topic=await one<{id:string}>("SELECT id FROM marketing_topics WHERE site_id=$1 AND status='planned' ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END,created_at,id LIMIT 1",[site.id]);
    if(!topic) throw new MarketingError('No planned topics remain. Refresh research or add a topic.');
    job.topic_id=topic.id;await query('UPDATE marketing_jobs SET topic_id=$2 WHERE id=$1',[job.id,topic.id]);
  }
  await write(job);
  site=siteView(await ownedSite(job.user_id,job.site_id));
  if(site.scheduleEnabled && site.publishMode==='auto') await publish(job,true);
}

export async function queueDueSchedules(now=new Date()) {
  await transaction(async client=>{
    const sites=(await client.query("SELECT * FROM marketing_sites WHERE schedule_enabled AND next_run_at<=$1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 30",[now])).rows;
    for(const row of sites) {
      if((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[row.id])).rowCount) continue;
      const key=`weekly:${row.id}:${new Date(row.next_run_at).toISOString()}`;
      await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,idempotency_key) VALUES($1,$2,$3,'cycle',$4) ON CONFLICT(idempotency_key) DO NOTHING",[randomUUID(),row.id,row.user_id,key]);
      await client.query('UPDATE marketing_sites SET next_run_at=$2 WHERE id=$1',[row.id,nextWeeklyRun(now,row.schedule_day,row.schedule_time,row.timezone)]);
    }
  });
}

export async function marketingTick() {
  if(busy || stopping || deploying()) return;
  busy=true;let client;
  try {
    client=await getPool().connect();
    if(!(await client.query('SELECT pg_try_advisory_lock(781240936) locked')).rows[0].locked) return;
    await query("UPDATE marketing_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error='Previous worker stopped; recovering saved progress.',available_at=now() WHERE status='running' AND heartbeat_at<now()-interval '90 seconds'");
    await queueDueSchedules();
    const job=await one<JobRow>(`UPDATE marketing_jobs SET status='running',attempts=attempts+1,heartbeat_at=now(),error=NULL WHERE id=(SELECT id FROM marketing_jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if(!job) return;
    const heartbeat=setInterval(()=>void query("UPDATE marketing_jobs SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>{}),20_000);
    try {await execute(job);await query("UPDATE marketing_jobs SET status='done',progress='Complete',finished_at=now() WHERE id=$1",[job.id]);}
    catch(error) {
      const permanent=error instanceof MarketingError || Number(job.attempts)>=3;
      const message=error instanceof MarketingError?error.message:'Research or writing could not finish. Check your public website and Admin model configuration, then retry.';
      console.warn('[marketing] job failed',job.id,(error as Error).message.slice(0,200));
      await query("UPDATE marketing_jobs SET status=$2,error=$3,progress=$4,available_at=now()+interval '5 minutes',finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",[job.id,permanent?'failed':'queued',message,permanent?'Needs attention':'Retrying in five minutes']);
      if(permanent && job.post_id) await query("UPDATE marketing_posts SET status='failed',updated_at=now() WHERE id=$1 AND status='writing'",[job.post_id]);
      if(permanent && job.topic_id) await query("UPDATE marketing_topics SET status='planned' WHERE id=$1 AND status='writing'",[job.topic_id]);
    } finally {clearInterval(heartbeat);}
  } catch(error) {console.warn('[marketing] worker:',(error as Error).message.slice(0,200));}
  finally {if(client) {await client.query('SELECT pg_advisory_unlock(781240936)').catch(()=>{});client.release();}busy=false;}
}

export function startMarketingWorker() {if(timer) return;stopping=false;timer=setInterval(()=>void marketingTick(),10_000);timer.unref();void marketingTick();}
export function stopMarketingWorker() {stopping=true;if(timer) clearInterval(timer);timer=undefined;stopMarketingBrowsers();}
