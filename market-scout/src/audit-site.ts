import type { Page } from 'patchright';
import { distill } from './browser/distill.js';
import { detectWall, withPage } from './browser/session.js';
import { publicWebsiteUrl, assertPublicUrl, samePublicSite as sameWebsite } from './core/public-url.js';
import { fetchText, parseRobots, politely } from './core/politeness.js';
import { buildSiteReadiness, htmlToText, validateLlmsTxt, wordCount, type PageReadiness, type SiteReadiness } from './geo-audit.js';

export interface SiteAudit {
  url: string;
  checkedAt: string;
  pages: Array<Record<string, unknown>>;
  robots: { url: string; status: number | null; body: string | null };
  sitemaps: Array<{ url: string; status: number | null; urls: string[]; error: string | null }>;
  gaps: string[];
  /** AI-search readiness measured from the same crawl. */
  readiness: SiteReadiness;
}

/**
 * A bounded, read-only audit of a public website: robots.txt, sitemaps, up to
 * twelve pages read in a real browser, each also fetched as a plain HTTP
 * client the way AI fetchers read it. The readiness findings are computed by
 * code from these measurements; nothing is scored by a model.
 */
export async function auditSite(raw:string, options: { brand?: string } = {}): Promise<SiteAudit> {
  const url=publicWebsiteUrl(raw); await assertPublicUrl(url);
  const checkedAt=new Date().toISOString();
  const pages:Array<Record<string,unknown>>=[], gaps:string[]=[], readinessPages: PageReadiness[] = [];
  const sitemaps:Array<{url:string;status:number|null;urls:string[];error:string|null}>=[];
  const deadline=Date.now()+210_000;
  return withPage(async page=>{
    const resource=async(target:string)=>{
      try {
        await assertPublicUrl(target);
        const response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:15_000});
        if(!sameWebsite(page.url(),url)) throw new Error('Resource redirected outside this website.');
        const wall=await detectWall(page); if(wall) throw new Error(wall);
        if(Number(response?.headers()['content-length'] || 0)>1024*1024) throw new Error('Resource exceeds the audit size limit.');
        const body=await response?.text() || '';
        if(body.length>1024*1024) throw new Error('Resource exceeds the audit size limit.');
        return {status:response?.status() || null,body,error:null as string|null};
      } catch {return {status:null,body:null,error:'Resource unavailable, blocked or redirected. No access restriction was bypassed.'};}
    };
    // What a non-browser client receives: robots.txt as crawlers read it, and each page as an AI fetcher reads it.
    const plain=async(target:string)=>{
      try {const response=await politely(target,()=>fetchText(target));return {status:response.status || null,body:response.status===200?response.body:null};}
      catch {return {status:null,body:null};}
    };
    const robotUrl=new URL('/robots.txt',url).href;
    const plainRobot=await plain(robotUrl);
    const robot=plainRobot.status===200 && plainRobot.body!==null?{status:200,body:plainRobot.body,error:null}:await resource(robotUrl);
    const validRobot=robot.status===200 && robot.body!==null && !/<(?:html|!doctype)/i.test(robot.body);
    const robots={url:robotUrl,status:robot.status ?? plainRobot.status,body:validRobot?robot.body:null};
    if(!validRobot && robot.status!==404 && robot.status!==410) gaps.push('robots.txt could not be interpreted; crawl permissions are unknown.');
    const allowed=validRobot?parseRobots(robot.body!,'MarketScout'):robot.status===404 || robot.status===410?parseRobots('','MarketScout'):null;
    const llms=await plain(new URL('/llms.txt',url).href);
    const llmsTxt=validateLlmsTxt(llms.body,llms.status,url);
    const finish=()=>({url,checkedAt,pages,robots,sitemaps,gaps,readiness:buildSiteReadiness({website:url,brand:options.brand ?? '',robotsBody:robots.body,robotsStatus:robots.status,llmsTxt,pages:readinessPages,gaps})});
    const mapTargets=[...(validRobot?parseRobots(robot.body!,'MarketScout').sitemaps:[]),new URL('/sitemap.xml',url).href];
    const targets:string[]=[url], seenMaps=new Set<string>();
    for(let i=0;i<mapTargets.length && seenMaps.size<3 && Date.now()<deadline;i++) {
      let target:string;
      try {const u=new URL(mapTargets[i]);if(u.protocol!=='https:' || !sameWebsite(u.href,url) || u.username || u.password || u.port) continue;target=u.href;} catch {continue;}
      if(seenMaps.has(target)) continue;seenMaps.add(target);
      const value=await resource(target);
      let urls:string[]=[];let index=false;
      if(value.status===200 && value.body) {
        const parsed=await page.evaluate((xml:string)=>{
          const doc=new DOMParser().parseFromString(xml,'application/xml');
          if(doc.querySelector('parsererror') || /<!DOCTYPE|<!ENTITY/i.test(xml)) return {valid:false,index:false,urls:[] as string[]};
          const root=doc.documentElement.localName;
          return {valid:['urlset','sitemapindex'].includes(root),index:root==='sitemapindex',urls:Array.from(doc.getElementsByTagNameNS('*','loc')).map(n=>n.textContent?.trim() || '').slice(0,500)};
        },value.body);
        if(!parsed.valid) value.error='The response is not a valid supported sitemap.';
        else {index=parsed.index;urls=parsed.urls.filter(u=>{try {return new URL(u).protocol==='https:' && sameWebsite(u,url) && !new URL(u).search;} catch{return false;}});}
      }
      sitemaps.push({url:target,status:value.status,urls:index?[]:urls,error:value.error || (value.status!==200?'Sitemap was not readable.':null)});
      if(index) mapTargets.push(...urls.slice(0,2));else targets.push(...urls);
    }
    if(!sitemaps.some(s=>s.status===200 && !s.error)) gaps.push('No readable XML sitemap was found; engines discover pages more slowly without one.');
    if(!allowed) {gaps.push('Page audit stopped because crawl permission could not be established.');return finish();}
    // Public, read-only pages only. URL selection is bounded; no account or cart actions.
    const safe=(u:string)=>{try {const p=new URL(u);return p.protocol==='https:' && sameWebsite(u,url) && !p.search && !p.username && !p.password && !p.port && !/\/(?:login|signin|sign-in|logout|checkout|cart|delete|admin|account|api)(?:\/|$)/i.test(p.pathname);}catch{return false;}};
    const visited=new Set<string>();
    for(let cursor=0;cursor<targets.length && pages.length<12 && Date.now()<deadline;cursor++) {
      const target=targets[cursor];if(visited.has(target) || !safe(target)) continue;visited.add(target);
      const path=new URL(target).pathname;
      if(!allowed.isAllowed(path)) {gaps.push(`robots.txt excludes ${target} from this audit.`);continue;}
      try {
        const response=await politely(target,()=>page.goto(target,{waitUntil:'domcontentloaded',timeout:15_000}));
        if(!sameWebsite(page.url(),url)) throw new Error('Page redirected outside this website.');
        const wall=await detectWall(page);if(wall) throw new Error(wall);
        await page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>{});
        const facts=await distill(page,4000);
        const status=response?.status() || null;
        if((status || 200)<400 && facts.wordCount<15) {pages.push({...emptyPage(target),status,error:'Not enough rendered page text was available. Content health is unknown.'});continue;}
        const extra=await measureReadiness(page);
        const raw=await plain(target);
        const pageType=cursor===0?'home':pageTypeOf(target);
        pages.push({url:facts.url,requestedUrl:target,status,title:facts.title,description:facts.metaDescription,canonical:facts.canonical,robotsMeta:facts.robotsMeta,xRobotsTag:response?.headers()['x-robots-tag'] || '',h1:facts.h1,wordCount:facts.wordCount,text:facts.markdown.slice(0,4000),links:facts.links.filter(l=>safe(l.href)).slice(0,80),jsonLdTypes:facts.jsonLdTypes,invalidJsonLd:extra.invalidJsonLd,imagesWithoutAlt:facts.imagesWithoutAlt,lang:facts.lang,error:null});
        readinessPages.push({url:facts.url,pageType,status,title:facts.title,h1:facts.h1,wordCount:facts.wordCount,rawWordCount:raw.body===null?null:wordCount(htmlToText(raw.body)),rawStatus:raw.status,leadWords:extra.leadWords,questionHeadings:extra.questionHeadings,lists:extra.lists,tables:extra.tables,dataNosnippet:extra.dataNosnippet,robotsMeta:facts.robotsMeta,xRobotsTag:response?.headers()['x-robots-tag'] || '',jsonLdTypes:facts.jsonLdTypes,invalidJsonLd:extra.invalidJsonLd,author:extra.author,dateModified:extra.dateModified,datePublished:extra.datePublished,faq:extra.faq,organization:extra.organization,lang:facts.lang});
        if(cursor===0) targets.splice(1,0,...facts.links.filter(l=>safe(l.href)).sort((a,b)=>Number(/product|service|pricing|blog|guide|about|faq/i.test(b.href))-Number(/product|service|pricing|blog|guide|about|faq/i.test(a.href))).slice(0,8).map(l=>l.href));
      } catch {pages.push(emptyPage(target));gaps.push(`Could not read ${target}: unavailable or access restricted.`);}
    }
    gaps.push('A sample of up to 12 public pages was checked. Unvisited links, full indexing, Core Web Vitals and search rankings are unmeasured.');
    return finish();
  });
}

function pageTypeOf(url:string):string {
  const path=new URL(url).pathname.toLowerCase();
  if(/\/(blog|news|articles?|posts?|guides?|learn|resources|insights)\/?$/.test(path)) return 'listing';
  if(/\/(blog|news|articles?|posts?|guides?|learn|resources|insights)\/[^/]+/.test(path)) return 'article';
  if(/\/(products?|shop|collections|store|services?|solutions?)(\/|$)/.test(path)) return 'product';
  if(/\/(pricing|plans)(\/|$)/.test(path)) return 'pricing';
  if(/\/(about|our-story|company|team)(\/|$)/.test(path)) return 'about';
  if(/\/(faq|help|support)(\/|$)/.test(path)) return 'faq';
  if(/\/(contact)(\/|$)/.test(path)) return 'contact';
  if(/\/(privacy|terms|conditions|cookies?|legal|disclaimer|refund-policy|shipping-policy)(\/|$)/.test(path)) return 'legal';
  return 'page';
}

/** Facts the readiness checks need beyond what `distill` collects, measured in the page. */
async function measureReadiness(page: Page) {
  const empty={invalidJsonLd:0,leadWords:0,questionHeadings:[] as string[],lists:0,tables:0,dataNosnippet:0,author:'',dateModified:'',datePublished:'',faq:false,organization:null as {name:string;sameAs:string[]}|null};
  try {
    return await page.evaluate(()=>{
      const clean=(v:unknown)=>String(v ?? '').replace(/\s+/g,' ').trim();
      const blocks=Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const nodes:Array<Record<string,unknown>>=[];let invalidJsonLd=0;
      for(const block of blocks) {
        try {
          const parsed=JSON.parse(block.textContent || '');
          const queue:unknown[]=[parsed];
          while(queue.length && nodes.length<60) {const n=queue.shift();if(Array.isArray(n)) queue.push(...n);else if(n && typeof n==='object') {nodes.push(n as Record<string,unknown>);const graph=(n as Record<string,unknown>)['@graph'];if(Array.isArray(graph)) queue.push(...graph);}}
        } catch {invalidJsonLd++;}
      }
      const typeOf=(n:Record<string,unknown>)=>{const t=n['@type'];return Array.isArray(t)?t.map(String):typeof t==='string'?[t]:[];};
      const org=nodes.find(n=>typeOf(n).some(t=>/Organization|LocalBusiness|Corporation|Store|Brand/i.test(t)));
      const sameAs=org?[(org as Record<string,unknown>).sameAs].flat().filter((v):v is string=>typeof v==='string'):[];
      const content=nodes.filter(n=>typeOf(n).some(t=>/Article|BlogPosting|NewsArticle|WebPage|Product|CreativeWork/i.test(t)));
      const article={author:content.map(n=>n.author).find(Boolean),dateModified:content.map(n=>n.dateModified).find(Boolean),datePublished:content.map(n=>n.datePublished).find(Boolean)};
      const authorNode=article.author as Record<string,unknown>|string|Array<Record<string,unknown>>|undefined;
      const authorFromSchema=typeof authorNode==='string'?authorNode:Array.isArray(authorNode)?clean(authorNode[0]?.name):clean(authorNode?.name);
      const meta=(sel:string)=>clean(document.querySelector(sel)?.getAttribute('content'));
      const author=authorFromSchema || meta('meta[name="author"]') || clean(document.querySelector('[rel="author"], .author, .byline, [itemprop="author"]')?.textContent);
      const dateModified=clean(article.dateModified) || meta('meta[property="article:modified_time"]') || clean(document.querySelector('time[itemprop="dateModified"]')?.getAttribute('datetime'));
      const datePublished=clean(article.datePublished) || meta('meta[property="article:published_time"]') || clean(document.querySelector('time[datetime]')?.getAttribute('datetime'));
      const h1=document.querySelector('h1');
      let lead='';
      if(h1) {
        // The first real paragraph after the heading, in document order: bylines, dates, share rows and labels are skipped.
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);walker.currentNode=h1;
        let node:Node|null;let seen=0;
        while((node=walker.nextNode()) && seen<400) {
          seen++;const el=node as HTMLElement;
          if(!/^(P|DIV|SECTION|LI)$/.test(el.tagName) || el.closest('nav, header, footer, aside, [role="navigation"]')) continue;
          if(/byline|meta|author|date|share|tags?|breadcrumb|label|eyebrow|caption/i.test(`${el.className} ${el.id}`) || el.querySelector('time')) continue;
          if([...el.children].some(c=>/^(P|DIV|SECTION|UL|OL|H[1-6]|TABLE|FIGURE)$/.test(c.tagName))) continue;
          const text=clean(el.innerText);
          if(text.length<60 || /^(by |published|updated|last updated|\d{1,2} \w+ \d{4}|\w+ \d{1,2}, \d{4})/i.test(text)) continue;
          lead=text;break;
        }
      }
      const main=document.querySelector('main, article, [role="main"]') ?? document.body;
      const questionHeadings=Array.from(main.querySelectorAll('h2, h3')).map(h=>clean((h as HTMLElement).innerText)).filter(t=>/\?\s*$/.test(t)).slice(0,20);
      return {invalidJsonLd,leadWords:lead?lead.split(' ').length:0,questionHeadings,lists:main.querySelectorAll('ul, ol').length,tables:main.querySelectorAll('table').length,dataNosnippet:document.querySelectorAll('[data-nosnippet]').length,author:author.slice(0,120),dateModified:dateModified.slice(0,40),datePublished:datePublished.slice(0,40),faq:nodes.some(n=>typeOf(n).includes('FAQPage')) || document.querySelectorAll('details > summary').length>=3,organization:org?{name:clean(org.name),sameAs:sameAs.slice(0,20)}:null};
    });
  } catch {return empty;}
}

function emptyPage(url:string) {return {url,requestedUrl:url,status:null,title:'',description:'',canonical:'',robotsMeta:'',xRobotsTag:'',h1:[],wordCount:0,text:'',links:[],jsonLdTypes:[],invalidJsonLd:0,imagesWithoutAlt:0,lang:'',error:'Page unavailable, blocked or redirected outside this website.'};}
