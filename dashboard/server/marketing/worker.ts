import { randomUUID } from 'node:crypto';
import { getPool, one, query } from '../db/index.js';
import { deploying } from '../runner.js';
import { auditWebsite, observeAI, readWebsite, researchWebsite, stopMarketingBrowsers } from './scout.js';
import { growthWorkspace, saveObservation, saveResultsSnapshot } from './growth-store.js';
import { automaticPublicationHold, newGrowthRun, nextGrowthTopic, resultsBrief, runGrowthSteps } from './autopilot.js';
import type { GrowthRun, GrowthStep } from '../../src/marketingTypes.js';
import { fetchReportingSnapshots } from './google-results.js';
import { planContent, reviewContent, writeContent } from './content.js';
import { articleHash, nextWeeklyRun, productsRemainVerified, publicationProblem, topicKey, validateArticle } from './policy.js';
import { MarketingError, marketingOrigin, ownedSite, ownerIsAdmin, siteView, topicView, transaction, type JobRow } from './store.js';

let timer: ReturnType<typeof setInterval> | undefined;
let busy=false, stopping=false;
const progress = async (job: JobRow, text: string) => { await query('UPDATE marketing_jobs SET progress=$2,heartbeat_at=now() WHERE id=$1',[job.id,text]); };

async function titles(siteId: string, internal: boolean) {
  const rows = await query<{title:string}>('SELECT title FROM marketing_topics WHERE site_id=$1',[siteId]);
  if (internal) rows.push(...await query<{title:string}>('SELECT title FROM blog_posts'));
  return rows.map(r=>r.title);
}

async function research(job: JobRow,includeHealth=true) {
  const before=siteView(await ownedSite(job.user_id,job.site_id));
  await progress(job,'Reading public product and service pages…');
  const profile=await readWebsite(before,job.user_id);
  if(includeHealth) {await progress(job,'Checking website health and crawl access…');await health(job);}
  await progress(job,'Finding competitors and buyer questions in the browser…');
  const snapshot=await researchWebsite(before,job.user_id,profile);
  // Model wording can change on a refresh; changed confirmed source facts need another review.
  await query(`UPDATE marketing_sites SET profile=$3,research=$4,name=CASE WHEN name='' THEN $5 ELSE name END,
    profile_confirmed=profile_confirmed AND $6::boolean,updated_at=now()
    WHERE id=$1 AND user_id=$2`,[job.site_id,job.user_id,profile,snapshot,profile.name,productsRemainVerified(before.profile,profile)]);
  await progress(job,'Building a useful, evidence-linked content plan…');
  const site=siteView(await ownedSite(job.user_id,job.site_id));
  const topics=await planContent(site,profile,snapshot,await titles(site.id,site.publisher==='owtomate'));
  await transaction(async client=>{
    await client.query('SELECT id FROM marketing_sites WHERE id=$1 FOR UPDATE',[site.id]);
    const count=Number((await client.query("SELECT count(*) n FROM marketing_topics WHERE site_id=$1 AND status IN ('planned','writing')",[site.id])).rows[0].n);
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
  if(!await ownerIsAdmin(job.user_id)) throw new MarketingError('Marketing is available to admins only.',403);
  if(job.kind==='cycle' || job.kind==='growth') return growthCycle(job);
  if(job.kind==='health') return health(job);
  if(job.kind==='visibility') {
    await progress(job,'Checking actual AI answers in a public browser…');
    const site=siteView(await ownedSite(job.user_id,job.site_id));
    const observations=await observeAI(site,job.user_id,job.payload);
    for(const observation of observations) await saveObservation(job.user_id,job.site_id,observation,'browser');
    return;
  }
  if(job.kind==='results') return syncResults(job);
  if(job.kind==='research') return research(job);
  if(job.kind==='write') return write(job);
  if(job.kind==='review') {await review(job);return;}
  if(job.kind==='publish') return publish(job);
  throw new MarketingError('Unknown marketing task.');
}

async function growthCycle(job:JobRow) {
  const report:GrowthRun=job.payload?.growthRun || newGrowthRun();
  const load=async()=>siteView(await ownedSite(job.user_id,job.site_id));
  const outcome=(status:'done'|'attention'|'skipped',summary:string)=>({status,summary});
  const perform=async(key:GrowthStep['key'])=>{
    let site=await load();
    if(key==='results') {
      const data=await growthWorkspace(job.user_id,site.id,site);
      if(!data.connection.connected || (!data.connection.searchProperty && !data.connection.gaProperty)) return outcome('attention','Connect Google reporting and select this website’s properties to measure traffic automatically. Existing imports remain available under Results.');
      await syncResults(job);
      return outcome('done',resultsBrief((await growthWorkspace(job.user_id,site.id)).results));
    }
    if(key==='health') {
      await health(job);site=await load();
      const report=site.health!;
      return outcome(report.pages.some(p=>!p.error && p.status!==null && p.status<400)?'done':'attention',`${report.pages.length} pages sampled; ${report.findings.filter(f=>f.severity==='urgent').length} urgent findings; ${report.pages.filter(p=>p.error || p.status===null).length} unreadable pages. See Website health for evidence. Findings require website changes; they have not been automatically fixed.`);
    }
    if(key==='research') {
      const planned=await one<{n:number}>("SELECT count(*)::int n FROM marketing_topics WHERE site_id=$1 AND user_id=$2 AND status='planned'",[site.id,job.user_id]);
      if(!site.research || !Number.isFinite(Date.parse(site.research.researchedAt)) || Date.now()-Date.parse(site.research.researchedAt)>6*86400_000 || !planned?.n) await research(job,false);
      site=await load();
      return outcome(site.research?.sources.some(s=>s.role==='own')?'done':'attention',`Research checked ${site.research?.researchedAt || 'at an unknown time'}. ${site.research?.competitors.length || 0} verified competitor leads; ${site.research?.gaps.length || 0} reported research gaps. Topics are proposals, not measured search demand.`);
    }
    if(key==='visibility') {
      if(!site.growthAIProvider || site.growthAIProvider==='off') return outcome('skipped','Weekly AI checks are off. Choose a browser provider in Growth autopilot to include them.');
      const count=await one<{n:number}>("SELECT count(*)::int n FROM marketing_ai_observations WHERE user_id=$1 AND created_at>now()-interval '24 hours'",[job.user_id]);
      if((count?.n || 0)>=10) return outcome('attention','Daily browser AI sample limit reached. Try another day.');
      const data=await growthWorkspace(job.user_id,site.id,site);
      if(!data.prompts.length) return outcome('attention','Website products must be identified before an AI discovery prompt can be created.');
      const observations=await observeAI(site,job.user_id,{provider:site.growthAIProvider,prompts:data.prompts.slice(0,1)});
      for(const observation of observations) await saveObservation(job.user_id,site.id,observation,'browser');
      const completed=observations.filter(o=>o.status==='complete');
      return outcome(completed.length?'done':'attention',completed.length?`${completed.length} real answer captured from ${site.growthAIProvider}. Review the answer and actual citations under AI visibility; a sample is not a universal ranking.`:'The provider could not be checked. AI visibility remains unknown for this run.');
    }
    if(key==='strategy') {
      const data=await growthWorkspace(job.user_id,site.id,site);
      const actions=data.strategy.actions.filter(a=>a.status==='open');
      const priorities=[...actions].sort((a,b)=>Number(b.kind==='fix' && b.priority==='high')-Number(a.kind==='fix' && a.priority==='high') || Number(b.kind==='refresh')-Number(a.kind==='refresh')).slice(0,3);
      return outcome(actions.length?'done':'attention',`${actions.length} open actions. ${priorities.map((a,i)=>`${i+1}. ${a.title}`).join(' ')} Existing-content overlap and dismissed actions are excluded from automatic new-blog selection. Review website fixes and content updates under Content strategy.`);
    }
    if(!site.profileConfirmed) return outcome('attention','Confirm the product description and audience before the agent writes or publishes. Research and audits are saved.');
    if(report.steps.find(s=>s.key==='research')?.status!=='done' || !site.research || Date.now()-Date.parse(site.research.researchedAt)>6*86400_000) return outcome('attention','Fresh usable research is required before creating content. Fix the research issue and run another growth review.');
    if(!job.topic_id) {
      const waiting=await one<{n:number}>("SELECT count(*)::int n FROM marketing_posts WHERE site_id=$1 AND user_id=$2 AND status='draft' AND handled_at IS NULL",[site.id,job.user_id]);
      if((waiting?.n || 0)>=3) return outcome('attention','Three or more drafts are awaiting review. Publish them or mark finished exports as handled in Blogs before another automated draft is created.');
      const data=await growthWorkspace(job.user_id,site.id,site);
      const topics=(await query('SELECT * FROM marketing_topics WHERE site_id=$1 AND user_id=$2 ORDER BY created_at,id',[site.id,job.user_id])).map(topicView);
      const topic=nextGrowthTopic(topics,data.strategy,site.growthGoal);
      if(!topic) return outcome('attention','No suitable new topic remains. Review existing-page improvements or refresh the topic plan; the agent will not create an overlapping or dismissed topic.');
      job.topic_id=topic.id;await query('UPDATE marketing_jobs SET topic_id=$2 WHERE id=$1',[job.id,topic.id]);
    }
    // A recovered job keeps the same topic and post; write() returns an existing draft instead of duplicating it.
    await write(job);site=await load();
    const post=await one('SELECT status,quality FROM marketing_posts WHERE id=$1 AND site_id=$2 AND user_id=$3',[job.post_id,site.id,job.user_id]);
    if(post?.status==='published') return outcome('done','The selected blog was published. Its URL is saved under Blogs.');
    if(!post?.quality?.approved) return outcome('attention','The draft is saved, but its source review needs attention. It has not been published. Open Blogs to review the issues.');
    if(job.kind==='cycle' && site.scheduleEnabled && site.publishMode==='auto') {
      const hold=automaticPublicationHold(site);
      if(hold || report.steps.find(s=>s.key==='health')?.status!=='done') return outcome('attention',hold || 'The current audit could not finish. The draft is saved for review.');
      await publish(job,true);
      const current=await one('SELECT status FROM marketing_posts WHERE id=$1',[job.post_id]);
      return outcome(current?.status==='published'?'done':'attention',current?.status==='published'?'A source-reviewed blog was published. See Blogs for its live URL. Traffic impact is not yet measured.':'Publication was paused. The reviewed draft remains available under Blogs.');
    }
    return outcome('done',site.publisher==='export'?'A source-reviewed draft is ready to export. This website has no publishing connector yet; upload it through your CMS.':'A source-reviewed draft is ready in Blogs. This review did not publish; weekly automatic publishing follows your saved settings.');
  };
  await runGrowthSteps(report,{
    allowed:async()=>await ownerIsAdmin(job.user_id) && (job.kind!=='cycle' || (await load()).scheduleEnabled),
    save:async growthRun=>{job.payload={...job.payload,growthRun};await query('UPDATE marketing_jobs SET payload=$2,heartbeat_at=now() WHERE id=$1',[job.id,job.payload]);const active=growthRun.steps.find(s=>s.status==='running');if(active) await progress(job,active.title);},
    perform,error:(e,key)=>{console.warn('[marketing] growth step failed',job.id,key,(e as Error).message?.slice(0,160));return e instanceof MarketingError?e.message:`${key} could not finish. Other completed work is saved. Retry with a new growth review.`;},
  });
}

export async function queueDueSchedules(now=new Date()) {
  await transaction(async client=>{
    const sites=(await client.query("SELECT * FROM marketing_sites WHERE schedule_enabled AND next_run_at<=$1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 30",[now])).rows;
    for(const row of sites) {
      if(!await ownerIsAdmin(row.user_id)) {await client.query('UPDATE marketing_sites SET schedule_enabled=false,next_run_at=NULL WHERE id=$1',[row.id]);continue;}
      if((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[row.id])).rowCount) continue;
      const key=`weekly:${row.id}:${new Date(row.next_run_at).toISOString()}`;
      await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,idempotency_key) VALUES($1,$2,$3,'cycle',$4) ON CONFLICT(idempotency_key) DO NOTHING",[randomUUID(),row.id,row.user_id,key]);
      await client.query('UPDATE marketing_sites SET next_run_at=$2 WHERE id=$1',[row.id,nextWeeklyRun(now,row.schedule_day,row.schedule_time,row.timezone)]);
    }
  });
}

async function health(job:JobRow) {
  await progress(job,'Auditing a bounded sample of public pages…');
  const site=siteView(await ownedSite(job.user_id,job.site_id));
  const report=await auditWebsite(site,job.user_id);
  await query('UPDATE marketing_sites SET health=$3,updated_at=now() WHERE id=$1 AND user_id=$2',[job.site_id,job.user_id,report]);
}
async function syncResults(job:JobRow) {
  await progress(job,'Reading measured Search Console and Analytics results…');
  try {
    const report=await fetchReportingSnapshots(job.user_id,job.site_id);
    for(const snapshot of report.snapshots) await saveResultsSnapshot(job.user_id,job.site_id,snapshot);
    await query("UPDATE marketing_google_connections SET last_sync_at=now(),next_sync_at=CASE WHEN daily_sync THEN now()+interval '24 hours' ELSE NULL END,error=$3 WHERE site_id=$1 AND user_id=$2",[job.site_id,job.user_id,report.errors.length?report.errors.join(' ').slice(0,1000):null]);
    if(report.errors.length) throw new MarketingError(`Reporting needs attention: ${report.errors.join(' ').slice(0,800)}`,409);
  } catch(e) {
    await query("UPDATE marketing_google_connections SET next_sync_at=CASE WHEN daily_sync THEN now()+interval '24 hours' ELSE NULL END,error=$3 WHERE site_id=$1 AND user_id=$2",[job.site_id,job.user_id,e instanceof MarketingError?e.message:'Reporting could not finish. Retry or reconnect Google.']);throw e;
  }
}
export async function queueDueReporting() {
  await transaction(async client=>{
    const rows=(await client.query('SELECT * FROM marketing_google_connections WHERE daily_sync AND next_sync_at<=now() ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 20')).rows;
    for(const row of rows) {
      await client.query('SELECT id FROM marketing_sites WHERE id=$1 FOR UPDATE',[row.site_id]);
      if(!await ownerIsAdmin(row.user_id)) {await client.query('UPDATE marketing_google_connections SET daily_sync=false,next_sync_at=NULL WHERE site_id=$1',[row.site_id]);continue;}
      if((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[row.site_id])).rowCount) continue;
      const id=randomUUID();
      await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,idempotency_key) VALUES($1,$2,$3,'results',$4)",[id,row.site_id,row.user_id,`results:${row.site_id}:${new Date(row.next_sync_at).toISOString()}`]);
      await client.query("UPDATE marketing_google_connections SET next_sync_at=now()+interval '24 hours' WHERE site_id=$1",[row.site_id]);
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
    await queueDueReporting();
    const job=await one<JobRow>(`UPDATE marketing_jobs SET status='running',attempts=attempts+1,heartbeat_at=now(),error=NULL WHERE id=(SELECT id FROM marketing_jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if(!job) return;
    const heartbeat=setInterval(()=>void query("UPDATE marketing_jobs SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>{}),20_000);
    try {await execute(job);const attention=job.payload?.growthRun?.steps.filter((s:GrowthStep)=>s.status==='attention').length || 0;await query("UPDATE marketing_jobs SET status='done',progress=$2,finished_at=now() WHERE id=$1",[job.id,attention?`Growth review finished · ${attention} steps need attention`:'Complete']);}
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
