import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { EMPLOYER_SOURCES, type EmployerSourceId, employerTargets } from '../../../seek-bot/src/employer-source-config.js';
import { paidProfiles, PAID_ACCOUNTS_SQL } from './accounts.js';
import { canonicalUrl, extractPage, normaliseJob } from './extract.js';
import { PublicCrawler, CrawlBlocked, CrawlDeferred, crawlUrl } from './network.js';
import { JobIndexStore } from './store.js';
import type { JobListing } from '../../../seek-bot/src/types.js';
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
export async function crawlCycle(store:JobIndexStore,reader:pg.Pool,options:{braveKey?:string;maxTasks?:number;crawler?:PublicCrawler;signal?:AbortSignal}={}):Promise<Record<string,unknown>> {
  const lock=await store.pool.connect();let cycleId:string|undefined;
  const stats={profiles:0,tasks:0,jobsSaved:0,matchesUpdated:0,blocked:0,failed:0,deferred:0,searchConfigured:!!options.braveKey,warnings:[] as string[]};
  try {
    if(!(await lock.query('SELECT pg_try_advisory_lock(830711,1) AS locked')).rows[0].locked)return {status:'busy'};
    await store.purgeInactive((await reader.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows.map(u=>u.id));
    if(!await store.enabled())return {status:'paused'};
    await store.pool.query("UPDATE crawl_cycles SET status='interrupted',finished_at=now() WHERE status='running'");
    cycleId=randomUUID();await store.pool.query('INSERT INTO crawl_cycles(id) VALUES($1)',[cycleId]);
    const {profiles,seeds,warnings}=await paidProfiles(reader,undefined,await store.cachedProfiles());stats.profiles=profiles.length;stats.warnings=warnings;
    await store.profiles(profiles);
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
    if(options.braveKey)for(const keyword of keys)await store.enqueue('search',{keyword},1);
    if(profiles.length) for(let i=0;i<(options.maxTasks??40)&&crawler.requests<crawler.maxRequests;i++) {
      options.signal?.throwIfAborted();if(!await store.enabled())break;
      const task=await store.claim();if(!task)break;stats.tasks++;
      try {
        const {payload:p}=task;
        if(task.kind==='feed') {
          let lastIssue:unknown;const feedFetch:typeof fetch=async(...args)=>{try{return await crawler.fetch(...args);}catch(e){lastIssue=e;throw e;}};
          const discovery=p.source==='smartrecruiters'?new SmartRecruitersDiscovery(p.target,{fetch:feedFetch,gapMs:0,warn:()=>{}}):new EmployerFeedDiscovery(p.source as Exclude<EmployerSourceId,'smartrecruiters'>,p.target,{fetch:feedFetch,gapMs:0,retryDelayMs:0,warn:()=>{}});
          try {
          if(p.job) {
            const full=await discovery.detail(p.job);const job=fromFeed(full);
            if(!job)throw Error('Employer returned no complete public description.');
            await store.save(job);stats.jobsSaved++;
          } else {
            const page=Number.isSafeInteger(p.page)?p.page:1;
            const listings=await discovery.search(p.keyword,page);
            for(const listing of listings) {
              const job=fromFeed(listing);
              if(p.source==='greenhouse'&&job) {await store.save(job);stats.jobsSaved++;}
              else await store.enqueue('feed',{source:p.source,target:p.target,job:listing},3);
            }
            if(p.source!=='greenhouse'&&listings.length>0&&page<10)await store.enqueue('feed',{source:p.source,target:p.target,keyword:p.keyword,page:page+1},2);
          }
          }catch(e){throw lastIssue??e;}
        } else if(task.kind==='search') {
          if(!options.braveKey)throw new CrawlBlocked('Web discovery requires a configured search-provider key.');
          if(!await store.reserveSearch())throw new CrawlDeferred(24*3600_000);
          const u=new URL('https://api.search.brave.com/res/v1/web/search');u.search=new URLSearchParams({q:`${String(p.keyword).slice(0,70)} jobs careers Australia`,country:'au',count:'20'}).toString();
          const response=await fetch(u,{headers:{'X-Subscription-Token':options.braveKey,Accept:'application/json'},signal:AbortSignal.any([AbortSignal.timeout(15_000),...(options.signal?[options.signal]:[])])});
          if(response.status===429)throw new CrawlDeferred(3600_000);if(!response.ok)throw Error('Search provider unavailable.');
          const body=await response.text();if(body.length>2_000_000)throw Error('Search result exceeded limit.');
          for(const result of (JSON.parse(body).web?.results??[]).slice(0,20))try{await store.enqueue('page',{url:crawlUrl(result.url).href,depth:0},2);}catch{/* invalid lead */}
        } else {
          const feed=discoveredFeed(p.url);
          if(feed)for(const keyword of feed.source==='greenhouse'?['']:keys)await store.enqueue('feed',{...feed,keyword},2);
          const page=await crawler.get(p.url,{signal:options.signal});
          if([404,410].includes(page.status))await store.close(canonicalUrl(p.url));
          else if(page.status>=400)throw Error('Public source returned an error.');
          else {
            const sitemap=/xml/.test(page.type)&&/<(?:urlset|sitemapindex)\b/.test(page.text);
            if(sitemap) {
              const parsed=new XMLParser({processEntities:false,ignoreAttributes:true}).parse(page.text);
              const entries=parsed.urlset?.url??parsed.sitemapindex?.sitemap??[];
              for(const entry of (Array.isArray(entries)?entries:[entries]).slice(0,200))try{const url=crawlUrl(entry.loc).href;if((p.depth??0)<2&&(/sitemap/i.test(url)||/career|jobs?|vacanc|opportunit/i.test(url)))await store.enqueue('page',{url,depth:(p.depth??0)+1},0);}catch{/* invalid sitemap lead */}
            } else {
              const found=extractPage(page.text,page.url);
              for(const closed of found.closedUrls)await store.close(closed);
              for(const job of found.jobs){await store.save(job);stats.jobsSaved++;}
              if((p.depth??0)<2)for(const url of found.links)try{await store.enqueue('page',{url:crawlUrl(url).href,depth:(p.depth??0)+1},0);}catch{/* non-public destination */}
              if((p.depth??0)===0)await store.enqueue('page',{url:`${new URL(page.url).origin}/sitemap.xml`,depth:1},0);
            }
          }
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
    stats.matchesUpdated=await store.rematch(activeProfiles);
    await store.pool.query("UPDATE crawl_cycles SET finished_at=now(),status='finished',stats=$2 WHERE id=$1",[cycleId,JSON.stringify(stats)]);
    return stats;
  } catch(e) {
    if(cycleId)await store.pool.query("UPDATE crawl_cycles SET finished_at=now(),status='failed',error=$2,stats=$3 WHERE id=$1",[cycleId,errorText(e),JSON.stringify(stats)]);
    throw e;
  } finally {await lock.query('SELECT pg_advisory_unlock(830711,1)');lock.release();}
}
