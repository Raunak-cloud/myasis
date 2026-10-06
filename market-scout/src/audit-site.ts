import { distill } from './browser/distill.js';
import { detectWall, withPage } from './browser/session.js';
import { publicWebsiteUrl, assertPublicUrl, samePublicSite as sameWebsite } from './core/public-url.js';
import { parseRobots, politely } from './core/politeness.js';

export async function auditSite(raw:string) {
  const url=publicWebsiteUrl(raw); await assertPublicUrl(url);
  const checkedAt=new Date().toISOString();
  const pages:Array<Record<string,unknown>>=[], gaps:string[]=[];
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
    const robotUrl=new URL('/robots.txt',url).href;
    const robot=await resource(robotUrl);
    const validRobot=robot.status===200 && robot.body!==null && !/<(?:html|!doctype)/i.test(robot.body);
    const robots={url:robotUrl,status:robot.status,body:validRobot?robot.body:null};
    if(!validRobot && robot.status!==404 && robot.status!==410) gaps.push('robots.txt could not be interpreted; crawl permissions are unknown.');
    const allowed=validRobot?parseRobots(robot.body!,'MarketScout'):robot.status===404 || robot.status===410?parseRobots('','MarketScout'):null;
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
    if(!allowed) return {url,checkedAt,pages,robots,sitemaps,gaps:[...gaps,'Page audit stopped because crawl permission could not be established.']};
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
        const facts=await distill(page,4000);
        const invalidJsonLd=await page.evaluate(()=>Array.from(document.querySelectorAll('script[type="application/ld+json"]')).filter(s=>{try {JSON.parse(s.textContent || '');return false;} catch{return true;}}).length);
        pages.push({url:facts.url,requestedUrl:target,status:response?.status() || null,title:facts.title,description:facts.metaDescription,canonical:facts.canonical,robotsMeta:facts.robotsMeta,xRobotsTag:response?.headers()['x-robots-tag'] || '',h1:facts.h1,wordCount:facts.wordCount,text:facts.markdown.slice(0,4000),links:facts.links.filter(l=>safe(l.href)).slice(0,80),jsonLdTypes:facts.jsonLdTypes,invalidJsonLd,imagesWithoutAlt:facts.imagesWithoutAlt,lang:facts.lang,error:null});
        if(cursor===0) targets.splice(1,0,...facts.links.filter(l=>safe(l.href)).sort((a,b)=>Number(/product|service|pricing|blog|guide/i.test(b.href))-Number(/product|service|pricing|blog|guide/i.test(a.href))).slice(0,8).map(l=>l.href));
      } catch {pages.push(emptyPage(target));gaps.push(`Could not read ${target}: unavailable or access restricted.`);}
    }
    gaps.push('A sample of up to 12 public pages was checked. Unvisited links, full indexing, Core Web Vitals and search rankings are unmeasured.');
    return {url,checkedAt,pages,robots,sitemaps,gaps};
  });
}

function emptyPage(url:string) {return {url,requestedUrl:url,status:null,title:'',description:'',canonical:'',robotsMeta:'',xRobotsTag:'',h1:[],wordCount:0,text:'',links:[],jsonLdTypes:[],invalidJsonLd:0,imagesWithoutAlt:0,lang:'',error:'Page unavailable, blocked or redirected outside this website.'};}

