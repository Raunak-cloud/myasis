import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { EMPLOYER_SOURCES, type EmployerSourceId, employerTargets, isEmployerSource } from '../../../seek-bot/src/employer-source-config.js';
import { paidProfiles, PAID_ACCOUNTS_SQL } from './accounts.js';
import { canonicalUrl, extractPage, normaliseJob,matchJob } from './extract.js';
import { PublicCrawler, CrawlBlocked, CrawlDeferred, crawlUrl, type PageResponse } from './network.js';
import { JobIndexStore } from './store.js';
import type { JobListing } from '../../../seek-bot/src/types.js';
import type {IndexedJob} from './types.js';
import {confirmedMatch,type FitReviewer} from './review.js';
import {australianEligibility} from './geography.js';
import {leverApiUrl,leverPublisherJob} from './lever.js';
interface Feed { search:(keyword:string,page:number)=>Promise<JobListing[]>;detail:(job:JobListing)=>Promise<JobListing> }
type FeedConstructor=new(source:EmployerSourceId,raw:string,options:Record<string,unknown>)=>Feed;

export function fromFeed(job:JobListing) {
  return normaliseJob({title:job.title,hiringOrganization:{name:job.company},description:job.description,url:job.url,identifier:job.id,datePosted:job.listedAt,jobLocation:{name:job.location,...(job.locationCountry?{address:{addressCountry:job.locationCountry}}:{})},workArrangement:job.workArrangement},job.url,job.platform);
}
/** New employers observed on the web join the same validated public-feed queue. */
export function discoveredFeed(raw:string):{source:EmployerSourceId;target:string}|null {
  try {
    const u=crawlUrl(raw),parts=u.pathname.split('/').filter(Boolean);let source:EmployerSourceId,target:string;
    if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)){source='greenhouse';target=parts[0];}
    else if(/\.myworkdayjobs\.com$/.test(u.hostname)){source='workday';target=`${u.origin}/${parts.slice(0,2).join('/')}`;}
    else return null;
    return {source,target:employerTargets(source,target)[0]};
  }catch{return null;}
}
const errorText=(e:unknown):string=>e instanceof Error?e.message.split('\n')[0].replace(/(?:postgres(?:ql)?|https?):\/\/\S+/g,'[source]').slice(0,350):'Public source could not be indexed.';
export async function crawlCycle(store:JobIndexStore,reader:pg.Pool,options:{scheduled?:boolean;reviewer?:FitReviewer;maxReviews?:number;maxTasks?:number;crawler?:PublicCrawler;signal?:AbortSignal}={}):Promise<Record<string,unknown>> {
  const lock=await store.pool.connect();let cycleId:string|undefined;
  let nextCrawlAt:Date|undefined;
  const stats={profiles:0,tasks:0,jobsSaved:0,matchesUpdated:0,fitCalls:0,filtered:0,locationExcluded:0,locationUnknown:0,blocked:0,failed:0,deferred:0,warnings:[] as string[]};
  try {
    if(!(await lock.query('SELECT pg_try_advisory_lock(830711,1) AS locked')).rows[0].locked)return {status:'busy'};
    await store.purgeInactive((await reader.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows.map(u=>u.id));
    const {profiles,evidence,seeds,warnings}=await paidProfiles(reader,undefined,await store.cachedProfiles());stats.profiles=profiles.length;stats.warnings=warnings;
    await store.profiles(profiles);
    if(!await store.enabled())return {status:'paused'};
    await store.pool.query("UPDATE crawl_cycles SET status='interrupted',finished_at=now() WHERE status='running'");
    // Under the existing single-worker lock, persist cadence through restarts
    // and deployments. Explicit operator --once diagnostics remain available.
    if(options.scheduled){
      const next=(await lock.query<{next:Date|null}>("SELECT max(started_at)+interval '6 hours' AS next FROM crawl_cycles")).rows[0]?.next;
      if(next&&next.getTime()>Date.now())return {status:'waiting',nextCrawlAt:next.toISOString()};
    }
    cycleId=randomUUID();
    const started=(await store.pool.query<{started_at:Date}>('INSERT INTO crawl_cycles(id) VALUES($1) RETURNING started_at',[cycleId])).rows[0].started_at;
    if(options.scheduled)nextCrawlAt=new Date(started.getTime()+6*60*60_000);
    const reviewsByOwner=new Map<string,number>();
    const ownerAllowance=Math.max(1,Math.ceil((options.maxReviews??8)/Math.max(1,profiles.length)));
    const admit=async(job:IndexedJob)=>{
      await store.invalidate(job);
      const eligibility=australianEligibility(job);
      if(eligibility.status!=='eligible'){stats.filtered++;if(eligibility.status==='excluded')stats.locationExcluded++;else stats.locationUnknown++;return;}
      let saved=false,pendingWait=0;
      for(const profile of profiles){
        const pre=matchJob(job,profile);if(!pre)continue;
        let match=await store.cachedDecision(profile,job);
        if(match==='uncertain'){pendingWait=3600_000;continue;}
        if(match===undefined){
          const facts=evidence.get(profile.userId);
          if(!facts?.resume){stats.warnings.push(`Account ${profile.userId}: professional evidence unavailable; no job admitted.`);continue;}
          if(!options.reviewer||stats.fitCalls>=(options.maxReviews??8)||(reviewsByOwner.get(profile.userId)??0)>=ownerAllowance){pendingWait=5*60_000;continue;}
          stats.fitCalls++;reviewsByOwner.set(profile.userId,(reviewsByOwner.get(profile.userId)??0)+1);
          let decision;
          try{decision=await options.reviewer(job,profile,facts,options.signal);}catch(error){if(error instanceof CrawlDeferred){pendingWait=error.waitMs;continue;}throw error;}
          match=confirmedMatch(decision,job,profile,facts,pre);
          const uncertain=decision.decision==='uncertain';
          await store.cacheDecision(profile,job,match,uncertain);
          if(uncertain){pendingWait=3600_000;continue;}
        }
        if(match){
          const active=(await reader.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows;
          if(active.some(u=>u.id===profile.userId)&&await store.save(job,[{profile,match}])){if(!saved)stats.jobsSaved++;saved=true;stats.matchesUpdated++;}
        }
      }
      if(pendingWait)throw new CrawlDeferred(pendingWait,'Some owner reviews remain uncertain, unavailable or over their cycle allowance; remaining work is queued.');
      if(!saved)stats.filtered++;
    };
    const crawler=options.crawler ?? new PublicCrawler();
    const {EmployerFeedDiscovery}=await import(/* @vite-ignore */ new URL('../../../seek-bot/dist/employer-feeds.js',import.meta.url).href) as {EmployerFeedDiscovery:FeedConstructor};
    const keys=[...new Set(profiles.flatMap(p=>p.keywords))];
    if(profiles.length) for(const source of EMPLOYER_SOURCES) {
      const values=[...new Set(profiles.flatMap(p=>{try{return employerTargets(source.id,p.sources[source.key]??source.defaults);}catch{return [];}}))];
      for(const target of values) {
        if(source.id==='greenhouse')await store.enqueue('feed',{source:source.id,target,keyword:''},2);
        else for(const keyword of keys)await store.enqueue('feed',{source:source.id,target,keyword},2);
      }
    }
    for(const url of seeds)try{await store.enqueue('page',{url:crawlUrl(url).href,depth:0},1);}catch{/* private/apply destination */}
    const savePage=async(page:PageResponse,depth:number)=>{
      if(page.status>=400)throw Error('Public source returned an error.');
      // Public employer discovery is independent of any one candidate's fit.
      const feed=discoveredFeed(page.url);if(feed)for(const keyword of feed.source==='greenhouse'?['']:keys)await store.enqueue('feed',{...feed,keyword},2);
      const sitemap=/xml/.test(page.type)&&/<(?:urlset|sitemapindex)\b/.test(page.text);
      if(sitemap) {
        const parsed=new XMLParser({processEntities:false,ignoreAttributes:true}).parse(page.text);
        const entries=parsed.urlset?.url??parsed.sitemapindex?.sitemap??[];
        for(const entry of (Array.isArray(entries)?entries:[entries]).slice(0,200))try{const url=crawlUrl(entry.loc).href;if(depth<2&&(/sitemap/i.test(url)||/career|jobs?|vacanc|opportunit/i.test(url)))await store.enqueue('page',{url,depth:depth+1},0);}catch{/* invalid publisher lead */}
      } else {
        const found=extractPage(page.text,page.url);
        const api=leverApiUrl(page.url);
        if(api){const record=await crawler.get(api,{signal:options.signal});const job=record.status===200?leverPublisherJob(page.text,page.url,JSON.parse(record.text)):null;if(job)found.jobs=[job];}
        for(const closed of found.closedUrls)await store.close(closed);
        for(const job of found.jobs)try{await admit(job);}catch(e){if(e instanceof CrawlDeferred)await store.enqueue('page',{url:job.url,depth:0},1);throw e;}
        // Only links actually found on the fetched publisher page enter the queue.
        if(depth<2)for(const url of found.links)try{await store.enqueue('page',{url:crawlUrl(url).href,depth:depth+1},0);}catch{/* non-public destination */}
        if(depth===0)await store.enqueue('page',{url:`${new URL(page.url).origin}/sitemap.xml`,depth:1},0);
      }
    };
    // Give every source a turn; a large blocked feed backlog must not starve
    // public pages or another employer integration.
    const lanes=[{kind:'page' as const},...EMPLOYER_SOURCES.map(s=>({kind:'feed' as const,source:s.id}))];
    if(profiles.length) for(let i=0;i<(options.maxTasks??40)&&crawler.requests<crawler.maxRequests;i++) {
      if(options.signal?.aborted||!await store.enabled())break;
      const task=await store.claim(lanes[i%lanes.length])??await store.claim();if(!task)break;stats.tasks++;
      try {
        const {payload:p}=task;
        if(task.kind==='feed') {
          if (!isEmployerSource(p.source)) {
            await store.finish(task, 'failed', 'Job source retired.');
            continue;
          }
          let lastIssue:unknown;const feedFetch:typeof fetch=async(...args)=>{try{return await crawler.fetch(...args);}catch(e){lastIssue=e;throw e;}};
          const discovery=new EmployerFeedDiscovery(p.source,p.target,{fetch:feedFetch,gapMs:0,retryDelayMs:0,warn:()=>{}});
          try {
          if(p.job) {
            const full=await discovery.detail(p.job);const job=fromFeed(full);
            if(!job)throw Error('Employer returned no complete public description.');
            await admit(job);
          } else {
            const page=Number.isSafeInteger(p.page)?p.page:1;
            const listings=await discovery.search(p.keyword,page);
            for(const listing of listings) {
              const job=fromFeed(listing);
              if(p.source==='greenhouse'&&job) {await admit(job);}
              else await store.enqueue('feed',{source:p.source,target:p.target,job:listing},3);
            }
            if(p.source!=='greenhouse'&&listings.length>0&&page<10)await store.enqueue('feed',{source:p.source,target:p.target,keyword:p.keyword,page:page+1},2);
          }
          }catch(e){throw lastIssue??e;}
        } else {
          const page=await crawler.get(crawlUrl(p.url).href,{signal:options.signal});
          if([404,410].includes(page.status))await store.close(canonicalUrl(p.url));
          else await savePage(page,p.depth??0);
        }
        await store.finish(task,'done');
      } catch(e) {
        if(e instanceof CrawlDeferred){stats.deferred++;await store.finish(task,'deferred',e.message,e.waitMs);}
        else if(e instanceof CrawlBlocked){stats.blocked++;await store.finish(task,'blocked',e.message,24*3600_000);}
        else{stats.failed++;await store.finish(task,'failed',errorText(e));}
      }
    }
    // Recheck paid status before exposing any newly computed private matches.
    const activeIds=(await reader.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows.map(u=>u.id);
    const activeProfiles=profiles.filter(p=>activeIds.includes(p.userId));await store.profiles(activeProfiles);
    await store.pool.query("UPDATE crawl_cycles SET finished_at=now(),status='finished',stats=$2 WHERE id=$1",[cycleId,JSON.stringify(stats)]);
    return {...stats,...(nextCrawlAt?{nextCrawlAt:nextCrawlAt.toISOString()}:{})};
  } catch(e) {
    if(cycleId)await store.pool.query("UPDATE crawl_cycles SET finished_at=now(),status='failed',error=$2,stats=$3 WHERE id=$1",[cycleId,errorText(e),JSON.stringify(stats)]);
    throw e;
  } finally {await lock.query('SELECT pg_advisory_unlock(830711,1)');lock.release();}
}
