import { createHash, randomUUID } from 'node:crypto';
import { parseRobots } from '../../../market-scout/src/core/robots.js';
import { samePublicSite as sameWebsite } from '../../../market-scout/src/core/public-url.js';
import type { AIObservation, ContentAction, HealthFinding, HealthPage, MarketingSite, MarketingTopic, OrganicStrategy, ResultsSnapshot, WebsiteHealth } from '../../src/marketingTypes.js';

export const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionId=(...value:unknown[])=>fingerprint(value).slice(0,32);
const cleanUrl=(raw:unknown):string|null=>{try {if(typeof raw!=='string') return null;const u=new URL(raw);return u.protocol==='https:' && !u.username && !u.password && !u.port && u.hostname.includes('.') && !/localhost|\.(local|internal|test)$|^[\d.]+$/.test(u.hostname)?u.href:null;} catch{return null;}};

export function healthReport(raw:{checkedAt:string;pages:HealthPage[];robots:WebsiteHealth['robots'];sitemaps:WebsiteHealth['sitemaps'];gaps:string[]},siteUrl:string):WebsiteHealth {
  const pages=raw.pages.filter(p=>sameWebsite(p.url,siteUrl)).slice(0,12);
  const findings:HealthFinding[]=[];
  const add=(severity:HealthFinding['severity'],title:string,url:string,evidence:string,action:string)=>findings.push({id:actionId(title,url,evidence),severity,title,url,evidence,action});
  for(const p of pages) {
    if(p.error || p.status===null) {add('improvement','Page could not be checked',p.requestedUrl,p.error || 'No HTTP response was recorded.','Check this page in a browser and rerun the audit. Its health is unknown.');continue;}
    if(p.status>=400) {add('urgent','Linked page returns an error',p.requestedUrl,`HTTP ${p.status}; final URL ${p.url}`,'Restore the page or update links pointing to it.');continue;}
    if(/(?:^|[\s,;:])(?:noindex|none)(?:$|[\s,;])/i.test(`${p.robotsMeta} ${p.xRobotsTag}`)) add('urgent','Page declares noindex',p.url,`Meta robots: ${p.robotsMeta || '(absent)'}; X-Robots-Tag: ${p.xRobotsTag || '(absent)'}`,'If this public page should appear in search, review its noindex directive. Keep intentional exclusions.');
    if(!p.title.trim()) add('improvement','Page title is missing',p.url,'The rendered document title was empty.','Add a specific title describing this page.');
    if(!p.description.trim()) add('improvement','Search description is missing',p.url,'No meta description was read.','Write a useful page-specific description. Search engines may choose a different snippet.');
    if(!p.h1.length) add('improvement','Main heading is missing',p.url,'No H1 was read from the rendered page.','Add a clear main heading describing the page.');
    if(!p.canonical) add('improvement','Canonical URL is missing',p.url,'No canonical link was read.','Review duplicate URL variants and set the intended canonical where appropriate.');
    else {const canonical=cleanUrl(p.canonical);if(!canonical || !sameWebsite(canonical,siteUrl)) add('improvement','Canonical points outside this website or is invalid',p.url,`Canonical: ${p.canonical}`,'Confirm that this canonical is intentional before changing it.');}
    if(p.invalidJsonLd) add('improvement','Structured data contains invalid JSON',p.url,`${p.invalidJsonLd} JSON-LD block(s) could not be parsed.`,'Fix the JSON and validate it. Valid JSON alone does not establish schema eligibility.');
    if(p.imagesWithoutAlt) add('improvement','Images lack an alt attribute',p.url,`${p.imagesWithoutAlt} image(s) without an alt attribute.`,'Describe meaningful images and use empty alt text for decorative images.');
    if(!p.lang) add('improvement','Document language is missing',p.url,'The HTML lang attribute was empty.','Set the language of the page for accessibility.');
  }
  const readable=pages.filter(p=>!p.error && p.status!==null && p.status<400);
  for(const key of ['title','description'] as const) {
    const groups=new Map<string,HealthPage[]>();
    for(const p of readable) {const text=p[key].trim().toLowerCase();if(text) groups.set(text,[...(groups.get(text) || []),p]);}
    for(const group of groups.values()) if(new Set(group.map(p=>p.url)).size>1) for(const p of group) add('improvement',`Repeated ${key==='title'?'page title':'search description'}`,p.url,`Also read on: ${group.filter(other=>other.url!==p.url).map(other=>other.url).join(', ')}`,'Review whether these pages need distinct descriptions of their purpose.');
  }
  const robotsKnown=raw.robots.body!==null || [404,410].includes(raw.robots.status || 0);
  const checkedPaths=[...new Set([siteUrl,...pages.map(p=>p.url)])];
  const crawlerAccess=['Googlebot','Bingbot','OAI-SearchBot','PerplexityBot','Claude-SearchBot'].map(bot=>{
    const rules=parseRobots(raw.robots.body || '',bot);let allowed=0,blocked=0,unknown=0;
    for(const path of checkedPaths) {if(!robotsKnown) unknown++;else if(rules.isAllowed(new URL(path).pathname+new URL(path).search)) allowed++;else blocked++;}
    return {bot,allowed,blocked,unknown};
  });
  if(!raw.sitemaps.some(m=>m.status===200 && !m.error && m.urls.length)) add('improvement','No readable URL sitemap was found',new URL('/sitemap.xml',siteUrl).href,'The bounded sitemap checks returned no usable page URLs.','Check the sitemap location and list it in robots.txt. This check does not establish indexing.');
  for(const bot of crawlerAccess.filter(b=>b.blocked)) add('improvement',`${bot.bot} is excluded from sampled paths`,raw.robots.url,`${bot.blocked} of ${checkedPaths.length} sampled paths are disallowed by the applicable robots rules.`,'Review whether the exclusions match your search visibility preferences. Bot delivery and inclusion remain unverified.');
  return {...raw,pages,findings,crawlerAccess,gaps:[...raw.gaps,'Declared crawler permission is a readiness check, not proof of indexing, AI citations or recommendations.']};
}

const stop=new Set('a an the to for in of on and or your our with how what is are can should best guide website'.split(' '));
const words=(text:string)=>[...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>2 && !stop.has(w)))];
export function contentStrategy(site:MarketingSite,topics:MarketingTopic[],states:Map<string,ContentAction['status']>,results:ResultsSnapshot[]):OrganicStrategy {
  const actions:ContentAction[]=[];
  const add=(a:Omit<ContentAction,'id'|'status'>)=>{const id=actionId(a.kind,a.url,a.targetUrl,a.title,a.topicId);if(!actions.some(v=>v.id===id)) actions.push({...a,id,status:states.get(id) || 'open'});};
  for(const f of site.health?.findings || []) add({kind:'fix',title:f.title,reason:`${f.evidence} ${f.action}`,url:f.url,evidenceUrls:[f.url],priority:f.severity==='urgent'?'high':'medium'});
  const pages=(site.health?.pages || []).filter(p=>!p.error && p.status!==null && p.status<400);
  for(const topic of topics.filter(t=>t.status==='planned')) {
    const tokens=words(topic.keyword);
    const matching=tokens.length>=2?pages.find(p=>{const hay=words(`${p.title} ${p.h1.join(' ')}`);return tokens.filter(t=>hay.includes(t)).length/tokens.length>=0.8 && new URL(p.url).pathname!=='/';}):undefined;
    if(matching) add({kind:'refresh',title:`Review existing coverage: ${topic.title}`,reason:'A sampled page title or main heading overlaps this focus topic. Review and improve that page before creating competing coverage; overlap is a suggestion, not confirmed duplicate content.',url:matching.url,evidenceUrls:[matching.url,...topic.evidenceUrls].slice(0,6),priority:topic.priority,topicId:topic.id});
    else add({kind:'new',title:topic.title,reason:`${topic.rationale} Demand and ranking difficulty are unmeasured.`,url:topic.productUrl,evidenceUrls:topic.evidenceUrls,priority:topic.priority,topicId:topic.id});
    const product=pages.find(p=>p.url===topic.productUrl);
    const supporting=pages.find(p=>p.url!==topic.productUrl && tokens.length>=2 && tokens.filter(t=>words(`${p.title} ${p.text.slice(0,1500)}`).includes(t)).length>=2);
    if(product && supporting && !supporting.links.some(l=>l.href===product.url)) add({kind:'link',title:`Connect relevant pages: ${supporting.title || 'Guide'} → ${product.title || 'Product'}`,reason:'Both pages were read; no link to this product URL was found in the sampled page links. Add one only where it helps readers.',url:supporting.url,targetUrl:product.url,evidenceUrls:[supporting.url,product.url],priority:'medium'});
  }
  const search=results.find(r=>r.source==='search-console');
  for(const p of (search?.pages || []).filter(p=>p.impressions>0 && p.clicks===0).slice(0,5)) if(sameWebsite(p.url,site.url)) add({kind:'refresh',title:'Review a page receiving impressions without clicks',reason:`${p.impressions} impressions and ${p.clicks} clicks in ${search!.periodStart}–${search!.periodEnd} (${search!.sourceLabel}). Review relevance and search presentation; an improvement is not guaranteed.`,url:p.url,evidenceUrls:[p.url],priority:'high'});
  return {generatedAt:new Date().toISOString(),actions:actions.sort((a,b)=>Number(b.priority==='high')-Number(a.priority==='high')).slice(0,150),clusters:[{name:'Buyer decisions',topics:topics.filter(t=>t.status!=='dismissed' && t.intent==='buy').map(t=>t.id)},{name:'Comparisons',topics:topics.filter(t=>t.status!=='dismissed' && t.intent==='compare').map(t=>t.id)},{name:'Practical guides',topics:topics.filter(t=>t.status!=='dismissed' && t.intent==='learn').map(t=>t.id)}],limits:['Action priorities are editorial suggestions, not measured traffic or conversion forecasts.','Only scanned pages and supplied evidence are considered; a coverage suggestion is not proof that the entire website lacks that topic.']};
}

export function visibilityPrompts(site:MarketingSite):string[] {
  const category=site.profile?.sells?.slice(0,160);if(!category) return [];
  const market={AU:'Australia',US:'the United States',GB:'the United Kingdom',CA:'Canada',NZ:'New Zealand',IN:'India',SG:'Singapore',DE:'Germany',FR:'France'}[site.country] || site.country;
  return [`Which businesses offer ${category} for customers in ${market}? Include sources.`,`What should I compare when choosing ${category} in ${market}? Give examples with sources.`];
}

export function normalizeObservation(raw:Record<string,unknown>,site:MarketingSite,method:AIObservation['method'],now=Date.now()):AIObservation {
  const provider=raw.provider as AIObservation['provider'];
  if(!['ChatGPT','Perplexity','Gemini','Claude','Copilot'].includes(provider)) throw new Error('Choose an AI provider.');
  const prompt=typeof raw.prompt==='string'?raw.prompt.trim():'';
  if(prompt.length<10 || prompt.length>500) throw new Error('Enter an exact prompt of 10–500 characters.');
  const status=method==='browser'?raw.status as AIObservation['status']:'complete';
  if(!['complete','blocked','unavailable'].includes(status)) throw new Error('Invalid observation status.');
  const stamp=typeof raw.observedAt==='string'?Date.parse(raw.observedAt):NaN;
  if(!Number.isFinite(stamp) || stamp>now+60_000 || stamp<now-366*86400_000) throw new Error('Enter a valid observation time within the last year.');
  const answer=status==='complete' && typeof raw.answer==='string'?raw.answer.trim():'';
  if(status==='complete' && (answer.length<100 || answer.length>30_000)) throw new Error('Include the complete answer (100–30,000 characters).');
  const citations=[...new Set((Array.isArray(raw.citations)?raw.citations:[]).map(cleanUrl).filter((u):u is string=>u!==null))].slice(0,60);
  const host=new URL(site.url).hostname.replace(/^www\./,'');
  const brand=site.name?.trim() || site.profile?.name?.trim() || '';
  const escaped=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const hasBrand=(text:string)=>text.toLowerCase().includes(host.toLowerCase()) || (brand.length>=4 && !/^(home|welcome|website|shop|store|example|products)$/i.test(brand) && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(brand)}(?:$|[^\\p{L}\\p{N}])`,'iu').test(text));
  const quote=typeof raw.recommendationQuote==='string'?raw.recommendationQuote.trim():'';
  if(quote && (quote.length<10 || quote.length>1500 || !answer.includes(quote) || !hasBrand(quote) || !/\b(?:recommend|consider|option|choice|choose|try|suitable|worth|best)\b/i.test(quote) || /\b(?:not|never|avoid|don't|cannot)\b/i.test(quote))) throw new Error('Use an exact, positive recommendation sentence identifying this business; a mention alone does not qualify.');
  const responseUrl=cleanUrl(raw.responseUrl);
  const note=method==='recorded'?'User-recorded answer and citation links; provider authenticity and search mode are unverified.':typeof raw.note==='string'?raw.note.slice(0,700):'Browser sample; model and search mode are unverified.';
  const data={provider,prompt,country:site.country,observedAt:new Date(stamp).toISOString(),status,method,answer,citations,responseUrl,mentioned:status==='complete'?hasBrand(answer):null,cited:status==='complete'?citations.some(u=>sameWebsite(u,site.url)):null,recommendationQuote:quote || null,model:method==='recorded'?'User-recorded; model unverified':'Model not exposed by browser',note};
  return {...data,id:randomUUID(),fingerprint:fingerprint(data)};
}
