import {parseHTML} from 'linkedom';
import {canonicalUrl,extractPage,matchJob,normaliseJob,plain} from './extract.js';
import {australianEligibility} from './geography.js';
import {paidProfiles,PAID_ACCOUNTS_SQL} from './accounts.js';
import {PublicCrawler} from './network.js';
import {confirmedMatch,type FitReviewer} from './review.js';
import type {JobIndexStore} from './store.js';
import type pg from 'pg';

export const MAX_CODEX_PACKET_BYTES=2_000_000;
const aggregatorDomains=['jora.com','adzuna.com','adzuna.com.au','jooble.org','careerjet.com.au','talent.com','jobrapido.com','simplyhired.com.au','joblum.com','jobsora.com','seek.com.au','seek.com','indeed.com','linkedin.com','glassdoor.com','glassdoor.com.au'];
export function aggregatorUrl(url:string):boolean{const h=new URL(canonicalUrl(url)).hostname.toLowerCase();return aggregatorDomains.some(d=>h===d||h.endsWith('.'+d));}
export const leadSchema={type:'object',additionalProperties:false,properties:{jobs:{type:'array',items:{type:'object',additionalProperties:false,properties:{url:{type:'string',description:'The final original employer or ATS job listing URL, never an aggregator or application submission URL.'},discoveredFrom:{type:['string','null'],description:'The Jora, Adzuna or other aggregator listing URL where this job was discovered; null when found directly.'},title:{type:'string'},company:{type:'string'},descriptionQuote:{type:'string'},locationQuote:{type:'string'},countryQuote:{type:'string'},workArrangement:{type:'string',enum:['remote','hybrid','onsite','not-mentioned']},postedQuote:{type:'string'},postedAt:{type:['string','null']}},required:['url','discoveredFrom','title','company','descriptionQuote','locationQuote','countryQuote','workArrangement','postedQuote','postedAt']}}},required:['jobs']};
export interface CodexLead {url:string;discoveredFrom?:string|null;title:string;company:string;descriptionQuote:string;locationQuote:string;countryQuote:string;workArrangement:string;postedQuote:string;postedAt:string|null}
const normal=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
const contains=(source:string,quote:string,min=3)=>normal(quote).length>=min&&normal(source).includes(normal(quote));
const provenance=(job:ReturnType<typeof normaliseJob>,lead:CodexLead)=>{if(job&&lead.discoveredFrom)job.evidence.discoverySource=canonicalUrl(lead.discoveredFrom);return job;};
/** Agent suggestions are not vacancies until re-fetched and bound to the exact
 * publisher page. Never fetch or execute arbitrary commands from agent output. */
export function publisherJob(html:string,url:string,lead:CodexLead){
 const canonical=canonicalUrl(url);if(canonicalUrl(lead.url)!==canonical||aggregatorUrl(canonical))return null;
 const extracted=extractPage(html,canonical);if(extracted.closedUrls.includes(canonical))return null;
 const parsed=extracted.jobs.find(j=>j.url===canonical);
 if(parsed)return provenance(parsed,lead);
 const {document}=parseHTML(html);
 // ASP.NET career pages may wrap the entire advert in a form. Remove controls,
 // not that container, and prefer the job scope over outer search/breadcrumb UI.
 document.querySelectorAll('script,style,nav,header,footer,input,select,textarea,button,noscript,template,[hidden]').forEach(n=>n.remove());
 const root=document.querySelector('#job-content')??document.querySelector('main')??document.querySelector('[role="main"]')??document.querySelector('article')??document.body??document;
 const source=plain(root.innerHTML??root.textContent??'');
 if(/\b(?:this (?:job|position|vacancy|job ad) (?:has (?:now )?(?:expired|closed)|is no longer available)|applications are no longer (?:being )?accepted|position has been filled)\b/i.test(source))return null;
 const heading=plain(root.querySelector('h1,h2')?.textContent??'');
 if(!heading||normal(heading).toLowerCase()!==normal(lead.title).toLowerCase()||!contains(source,lead.company,2)||!contains(source,lead.descriptionQuote,100)||!contains(source,lead.locationQuote))return null;
 const local=australianEligibility({locations:[lead.locationQuote],applicantLocations:[],workArrangement:'not-mentioned'}).status==='eligible';
 const explicit=contains(source,lead.countryQuote,12)&&/\bAustralia\b/i.test(lead.countryQuote)&&/\b(?:role|position|job|work|based|located|location|remote|offices)\b/i.test(lead.countryQuote);
 if(!local&&!explicit)return null;
 // Date-only publisher text is a calendar day, not the import host's timezone.
 const quotedDate=Date.parse(lead.postedQuote+' UTC');
 const postedAt=lead.postedAt&&contains(source,lead.postedQuote)&&Number.isFinite(quotedDate)&&new Date(quotedDate).toISOString().slice(0,10)===new Date(lead.postedAt).toISOString().slice(0,10)?lead.postedAt:undefined;
 const job=normaliseJob({title:lead.title,hiringOrganization:{name:lead.company},description:source,url:canonical,jobLocation:{name:lead.locationQuote,address:{addressCountry:'AU'}},datePosted:postedAt},canonical,'codex-discovery');
 if(job){job.evidence.publisherLocation=lead.locationQuote;job.evidence.countryVerification=local?lead.locationQuote:lead.countryQuote;}
 return provenance(job,lead);
}
export function parseLeads(value:unknown):CodexLead[]{
 if(Buffer.byteLength(JSON.stringify(value)??'')>MAX_CODEX_PACKET_BYTES)throw Error('Codex results exceeded the safe transfer size.');
 const jobs=(value as any)?.jobs;if(!Array.isArray(jobs))throw Error('Codex returned an invalid job list.');
 const keys=['url','title','company','descriptionQuote','locationQuote','countryQuote','workArrangement','postedQuote'];
 for(const j of jobs){if(!j||keys.some(k=>typeof j[k]!=='string'||j[k].length>4000)||!['remote','hybrid','onsite','not-mentioned'].includes(j.workArrangement)||(j.postedAt!==null&&(typeof j.postedAt!=='string'||!Number.isFinite(Date.parse(j.postedAt)))))throw Error('Codex returned invalid listing fields.');canonicalUrl(j.url);if(j.discoveredFrom!==undefined&&j.discoveredFrom!==null){if(typeof j.discoveredFrom!=='string')throw Error('Invalid discovery source.');canonicalUrl(j.discoveredFrom);}}
 return [...new Map(jobs.map(j=>[canonicalUrl(j.url),j])).values()];
}
export async function importCodexJobs(store:JobIndexStore,reader:pg.Pool,leads:CodexLead[],reviewer:FitReviewer,crawler=new PublicCrawler(),signal?:AbortSignal){
 const {profiles,evidence}=await paidProfiles(reader,undefined,await store.cachedProfiles());await store.profiles(profiles);
 const stats={discovered:leads.length,verified:0,newJobs:0,matchesUpdated:0,notVerified:0,blocked:0,fitCalls:0,fitUnavailable:0,fitDeferred:0,unprocessed:0};
 const before=new Set((await store.pool.query('SELECT id FROM indexed_jobs')).rows.map(r=>r.id));
 for(const [index,lead] of leads.entries()){
  if(signal?.aborted||crawler.requests>=crawler.maxRequests||!await store.enabled()){stats.unprocessed=leads.length-index;break;}
  if(aggregatorUrl(lead.url)){stats.notVerified++;continue;}
  let job;try{const page=await crawler.get(lead.url,{signal});if(page.status!==200){stats.blocked++;continue;}job=publisherJob(page.text,page.url,lead);}catch{stats.blocked++;continue;}
  if(!job||australianEligibility(job).status!=='eligible'){stats.notVerified++;continue;}stats.verified++;
  await store.invalidate(job);let saved=false;
  for(const profile of profiles){
   const pre=matchJob(job,profile),facts=evidence.get(profile.userId);if(!pre||!facts?.resume)continue;
   let match=await store.cachedDecision(profile,job);if(match==='uncertain'){stats.fitDeferred++;continue;}
   if(match===undefined){if(stats.fitCalls>=24){stats.fitDeferred++;continue;}stats.fitCalls++;try{const d=await reviewer(job,profile,facts,signal);match=confirmedMatch(d,job,profile,facts,pre);await store.cacheDecision(profile,job,match,d.decision==='uncertain');if(d.decision==='uncertain')stats.fitDeferred++;}catch{stats.fitUnavailable++;continue;}}
   if(match&&(await reader.query<{id:string}>(PAID_ACCOUNTS_SQL)).rows.some(r=>r.id===profile.userId)&&await store.save(job,[{profile,match}])){stats.matchesUpdated++;saved=true;}
  }
  if(saved&&!before.has(job.id)){stats.newJobs++;before.add(job.id);}
 }
 return stats;
}
