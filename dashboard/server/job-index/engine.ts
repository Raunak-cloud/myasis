import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { EMPLOYER_SOURCES, type EmployerSourceId, employerTargets } from '../../../seek-bot/src/employer-source-config.js';
import { paidProfiles, PAID_ACCOUNTS_SQL } from './accounts.js';
import { canonicalUrl, extractPage, normaliseJob,matchJob } from './extract.js';
import { PublicCrawler, CrawlBlocked, CrawlDeferred, crawlUrl, type PageResponse } from './network.js';
import { JobIndexStore } from './store.js';
import type { JobListing } from '../../../seek-bot/src/types.js';
import type {IndexedJob} from './types.js';
import {confirmedMatch,type FitReviewer} from './review.js';
import {discoveryQueries} from './discovery.js';
interface Feed { search:(keyword:string,page:number)=>Promise<JobListing[]>;detail:(job:JobListing)=>Promise<JobListing> }
type FeedConstructor=new(source:Exclude<EmployerSourceId,'smartrecruiters'>,raw:string,options:Record<string,unknown>)=>Feed;
type SmartConstructor=new(raw:string,options:Record<string,unknown>)=>Feed;

function fromFeed(job:JobListing) {
  return normaliseJob({title:job.title,hiringOrganization:{name:job.company},description:job.description,url:job.url,identifier:job.id,datePosted:job.listedAt,jobLocation:{name:job.location},workArrangement:job.workArrangement},job.url,job.platform);
}
/** New employers observed on the web join the same validated public-feed queue. */
export function discoveredFeed(raw:string):{source:EmployerSourceId;target:string}|null {
  try {
    const u=crawlUrl(raw),parts=u.pathname.split('/').filter(Boolean);let source:EmployerSourceId,target:string;
    if(['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname)){source='greenhouse';target=parts[0];}
    else if(u.hostname==='jobs.smartrecruiters.com'){source='smartrecruiters';target=parts[0];}
    else if(/\.myworkdayjobs\.com$/.test(u.hostname)){source='workday';target=`${u.origin}/${parts.slice(0,2).join('/')}`;}
    else if(u.hostname==='careers.pageuppeople.com'){source='pageup';target=`${u.origin}/${parts.slice(0,3).join('/')}`;}
    else return null;
    return {source,target:employerTargets(source,target)[0]};
  }catch{return null;}
}
const errorText=(e:unknown):string=>e instanceof Error?e.message.split('\n')[0].replace(/(?:postgres(?:ql)?|https?):\/\/\S+/g,'[source]').slice(0,350):'Public source could not be indexed.';
export async function crawlCycle(store:JobIndexStore,reader:pg.Pool,options:{scheduled?:boolean;braveKey?:string;reviewer?:FitReviewer;maxReviews?:number;maxTasks?:number;crawler?:PublicCrawler;searchFetch?:typeof fetch;signal?:AbortSignal}={}):Promise<Record<string,unknown>> {
  const lock=await store.pool.connect();let cycleId:string|undefined;
  let nextCrawlAt:Date|undefined;
  const stats={profiles:0,tasks:0,jobsSaved:0,matchesUpdated:0,fitCalls:0,filtered:0,blocked:0,failed:0,deferred:0,searchConfigured:!!options.braveKey,warnings:[] as string[]};
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
      await store.invalidate(job);let saved=false,pendingWait=0;
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
    const crawler=options.crawler??new PublicCrawler();
    const {EmployerFeedDiscovery}=await import(/* @vite-ignore */ new URL('../../../seek-bot/dist/employer-feeds.js',import.meta.url).href) as {EmployerFeedDiscovery:FeedConstructor};
    const {SmartRecruitersDiscovery}=await import(/* @vite-ignore */ new URL('../../../seek-bot/dist/smartrecruiters.js',import.meta.url).href) as {SmartRecruitersDiscovery:SmartConstructor};
    const keys=[...new Set(profiles.flatMap(p=>p.keywords))];
    if(profiles.length) for(const source of EMPLOYER_SOURCES) {
      const values=[...new Set(profiles.flatMap(p=>{try{return employerTargets(source.id,p.sources[source.key]??source.defaults);}catch{return [];}}))];
      for(const target of values) {
        if(source.id==='greenhouse')await store.enqueue('feed',{source:source.id,target,keyword:''},2);
        else for(const keyword of keys)await store.enqueue('feed',{source:source.id,target,keyword},2);
      }
    }
    for(const url of seeds)try{await store.enqueue('page',{url:crawlUrl(url).href,depth:0},1);}catch{/* private/apply destination */}
    const queries=discoveryQueries(profiles);
    if(options.braveKey)for(const query of queries)await store.enqueue('search',{query},1);
    const savePage=async(page:PageResponse,depth:number,transient=false)=>{
      if(page.status>=400)throw Error('Public source returned an error.');
      // Public employer discovery is independent of any one candidate's fit.
      const feed=discoveredFeed(page.url);if(feed)for(const keyword of feed.source==='greenhouse'?['']:keys)await store.enqueue('feed',{...feed,keyword},2);
      const sitemap=/xml/.test(page.type)&&/<(?:urlset|sitemapindex)\b/.test(page.text);
      if(sitemap) {
        const parsed=new XMLParser({processEntities:false,ignoreAttributes:true}).parse(page.text);
        const entries=parsed.urlset?.url??parsed.sitemapindex?.sitemap??[];
        for(const entry of (Array.isArray(entries)?entries:[entries]).slice(0,200))try{const url=crawlUrl(entry.loc).href;if(depth<2&&(/sitemap/i.test(url)||/career|jobs?|vacanc|opportunit/i.test(url)))await store.enqueue('page',{url,depth:depth+1},0);}catch{/* invalid publisher lead */}
      } else {
        const found=extractPage(page.text,page.url,transient);
        for(const closed of found.closedUrls)await store.close(closed);
        for(const job of found.jobs)try{await admit(job);}catch(e){if(e instanceof CrawlDeferred)await store.enqueue('page',{url:job.url,depth:0},1);throw e;}
        // Only links actually found on the fetched publisher page enter the queue.
        if(depth<2)for(const url of found.links)try{await store.enqueue('page',{url:crawlUrl(url).href,depth:depth+1},0);}catch{/* non-public destination */}
        if(!transient&&depth===0)await store.enqueue('page',{url:`${new URL(page.url).origin}/sitemap.xml`,depth:1},0);
      }
    };
    // Give every source a turn; a large blocked feed backlog must not starve
    // public pages, provider discovery or another employer integration.
    const lanes=[{kind:'page' as const},{kind:'search' as const},...EMPLOYER_SOURCES.map(s=>({kind:'feed' as const,source:s.id}))];
    if(profiles.length) for(let i=0;i<(options.maxTasks??40)&&crawler.requests<crawler.maxRequests;i++) {
      if(options.signal?.aborted||!await store.enabled())break;
      const task=await store.claim(lanes[i%lanes.length])??await store.claim();if(!task)break;stats.tasks++;
      try {
        const {payload:p}=task;
        if(task.kind==='feed') {
          let lastIssue:unknown;const feedFetch:typeof fetch=async(...args)=>{try{return await crawler.fetch(...args);}catch(e){lastIssue=e;throw e;}};
          const discovery=p.source==='smartrecruiters'?new SmartRecruitersDiscovery(p.target,{fetch:feedFetch,gapMs:0,warn:()=>{}}):new EmployerFeedDiscovery(p.source as Exclude<EmployerSourceId,'smartrecruiters'>,p.target,{fetch:feedFetch,gapMs:0,retryDelayMs:0,warn:()=>{}});
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
        } else if(task.kind==='search') {
          if(!queries.includes(p.query)){await store.finish(task,'done',null,24*3600_000);continue;}
          if(!options.braveKey)throw new CrawlBlocked('Web discovery requires a configured search-provider key.');
          if(!await store.reserveSearch())throw new CrawlDeferred(24*3600_000);
          const u=new URL('https://api.search.brave.com/res/v1/web/search');u.search=new URLSearchParams({q:p.query,country:'au',count:'10',freshness:'pm'}).toString();
          const response=await (options.searchFetch??fetch)(u,{headers:{'X-Subscription-Token':options.braveKey,Accept:'application/json'},signal:AbortSignal.any([AbortSignal.timeout(15_000),...(options.signal?[options.signal]:[])])});
          if(response.status===429)throw new CrawlDeferred(3600_000);if(!response.ok)throw Error('Search provider unavailable.');
          const body=await response.text();if(body.length>2_000_000)throw Error('Search result exceeded limit.');
          // Provider responses, including returned URLs/snippets, remain in memory.
          // Persist only facts/links independently observed on employer pages.
          let leadFailures=0;
          for(const result of (JSON.parse(body).web?.results??[]).slice(0,20)) {
            if(options.signal?.aborted||crawler.requests>=crawler.maxRequests)break;
            if(!await store.enabled())break;
            try{await savePage(await crawler.get(crawlUrl(result.url).href,{signal:options.signal}),0,true);}
            catch(e){if(e instanceof CrawlBlocked)stats.blocked++;else if(e instanceof CrawlDeferred)stats.deferred++;else leadFailures++;}
          }
          if(leadFailures){stats.failed+=leadFailures;stats.warnings.push(`${leadFailures} search leads could not be fetched; discovery will try again in its next cycle.`);}
        } else {
          const page=await crawler.get(p.url,{signal:options.signal});
          if([404,410].includes(page.status))await store.close(canonicalUrl(p.url));
          else await savePage(page,p.depth??0);
        }
        await store.finish(task,'done',null,task.kind==='search'?24*3600_000:6*3600_000);
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
