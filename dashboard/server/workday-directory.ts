import {query} from './db/index.js';
import {indexConfig,indexStore} from './job-index/config.js';
import {safeKeywords} from './job-index/accounts.js';
import {workdaySite,workdayDirectoryTargets} from '../../seek-bot/src/workday-directory.js';

type DirectoryCatalog = { key?:string; reserveSearch:()=>Promise<boolean>; targets:()=>Promise<string[]> };
type DirectoryOptions = {db?:typeof query;network?:typeof fetch;catalog?:DirectoryCatalog|null;now?:()=>number};
type Candidate={site:string;label:string};
export function workdayCandidates(values:Array<{url:string;company?:string}>):Candidate[]{
 const all=new Map<string,Candidate>();for(const v of values){const site=workdaySite(v.url);if(site&&!all.has(site))all.set(site,{site,label:(v.company??'').replace(/[|,\r\n]/g,' ').slice(0,100)});}return [...all.values()];
}
/** On-demand discovery only. Uses the existing global provider budget; no new subscription or timer. */
export async function expandedWorkdaySites(raw:string,keywords:string,discover=true,options:DirectoryOptions={}):Promise<string[]> {
 const db=options.db??query,network=options.network??fetch;
 const configured=workdayDirectoryTargets(raw.split(','));
 const candidates:Candidate[]=configured.map(s=>({site:workdaySite(s.split('|').at(-1)!)!,label:s.includes('|')?s.split('|')[0]:''}));
 const history=await db<{url:string;company:string}>(`SELECT DISTINCT url,company FROM applications WHERE url LIKE '%myworkdayjobs.com/%'
  UNION SELECT DISTINCT application_url AS url,company FROM applications WHERE application_url LIKE '%myworkdayjobs.com/%'`);
 candidates.push(...workdayCandidates(history));
 let catalog=options.catalog;
 if(catalog===undefined){const config=indexConfig(),store=config?indexStore():null;catalog=store?{key:config?.braveKey,reserveSearch:()=>store.reserveSearch(),targets:async()=>(await store.pool.query<{target:string}>("SELECT DISTINCT payload->>'target' AS target FROM crawl_tasks WHERE kind='feed' AND payload->>'source'='workday'")).rows.map(v=>v.target).filter(Boolean)}:null;}
 if(catalog){try{candidates.push(...workdayCandidates((await catalog.targets()).map(target=>({url:target.split('|').at(-1)!}))));}catch{/* Configured sources remain usable when the external index is unavailable. */}}

 if(discover&&catalog?.key){
  for(const term of ['Australian jobs',...safeKeywords(keywords)].slice(0,2)){
   const text=`site:myworkdayjobs.com "Australia" ${term}`;
   const reserved=await db('INSERT INTO workday_directory_searches(query) VALUES($1) ON CONFLICT DO NOTHING RETURNING query',[text]);
   if(!reserved.length)continue;
   try{
    if(!await catalog.reserveSearch())continue;
    const offset=Math.floor((options.now??Date.now)()/86400_000)%10;
    const u=new URL('https://api.search.brave.com/res/v1/web/search');u.search=new URLSearchParams({q:text,country:'au',count:'20',offset:String(offset)}).toString();
    const response=await network(u,{redirect:'error',headers:{Accept:'application/json','X-Subscription-Token':catalog.key},signal:AbortSignal.timeout(12_000)});
    if(!response.ok)throw Error('Employer discovery unavailable.');
    const data=await response.json();candidates.push(...workdayCandidates((data.web?.results??[]).filter((v:any)=>typeof v.url==='string').map((v:any)=>({url:v.url}))));
   }catch{await db('DELETE FROM workday_directory_searches WHERE query=$1 AND day=current_date',[text]);}
  }
 }
 for(const c of candidates)await db(`INSERT INTO workday_directory(site,label) VALUES($1,$2) ON CONFLICT(site) DO UPDATE SET last_seen_at=now(),label=CASE WHEN workday_directory.label='' THEN excluded.label ELSE workday_directory.label END`,[c.site,c.label]);
 const saved=await db<Candidate>('SELECT site,label FROM workday_directory ORDER BY site');
 return workdayDirectoryTargets([...configured,...saved.map(c=>c.label?`${c.label}|${c.site}`:c.site)]);
}
