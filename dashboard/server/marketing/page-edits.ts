import { createHash } from 'node:crypto';
import type { WebsitePatch } from '../../src/marketingTypes.js';

// Only these public content routes have a built-in write adapter. Never edit app, legal or auth pages.
export function editablePath(raw:string,origin:string):string|null {
  try {
    const url=new URL(raw);
    if(url.origin!==origin || url.search || url.hash || url.username || url.password) return null;
    return url.pathname==='/' || url.pathname==='/blog' || url.pathname==='/automate-job-applications-australia' || /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname) ? url.pathname : null;
  } catch {return null;}
}
const escapeHtml=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const decode=(text:string)=>text.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi,e=>{
  const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'"};
  if(named[e.toLowerCase()]) return named[e.toLowerCase()];
  const n=e.toLowerCase().startsWith('&#x')?parseInt(e.slice(3,-1),16):parseInt(e.slice(2,-1),10);
  return n>0 && n<=0x10ffff?String.fromCodePoint(n):e;
});
const attr=(tag:string,key:string)=>decode(tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'))?.slice(1).find(v=>v!==undefined) || '');
const plainText=(html:string)=>decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const tags=(html:string,name:string)=>html.match(new RegExp(`<${name}\\b[^>]*>`,'gi')) || [];
export function readPageFields(html:string) {
  return {
    title:plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    description:attr(tags(html,'meta').find(t=>attr(t,'name').toLowerCase()==='description') || '', 'content'),
    canonical:attr(tags(html,'link').find(t=>attr(t,'rel').toLowerCase()==='canonical') || '', 'href'),
    h1:plainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''),
    lang:attr(tags(html,'html')[0] || '', 'lang'),
    text:plainText(html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html),
  };
}
export function pageSourceHash(html:string):string {
  // Ignore build hashes, analytics and request-specific script attributes, retain visible content and controls.
  return createHash('sha256').update(JSON.stringify({fields:readPageFields(html),
    controls:tags(html,'meta').filter(t=>/robots/i.test(attr(t,'name'))),
    links:tags(html,'a').map(t=>attr(t,'href')),
    schema:(html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []).map(s=>s.replace(/\s+/g,' ')),
  })).digest('hex');
}
function headTag(html:string,match:(tag:string)=>boolean,name:string,replacement:string):string {
  let replaced=false;
  const result=html.replace(new RegExp(`<${name}\\b[^>]*>`,'gi'),tag=>{if(!match(tag)) return tag;if(replaced) return '';replaced=true;return replacement;});
  return replaced?result:result.replace(/<\/head\s*>/i,`${replacement}\n</head>`);
}
function enhancementSection(patch:WebsitePatch):string {
  if(!patch.summary && !patch.links?.length) return '';
  return `<section data-marketing-enhancements="true" aria-label="Page summary and related reading">${patch.summary?`<p>${escapeHtml(patch.summary)}</p>`:''}${patch.links?.length?`<nav aria-label="Related reading"><ul>${patch.links.map(l=>`<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a></li>`).join('')}</ul></nav>`:''}</section>`;
}
/** Text-only edits to our controlled templates; model HTML is never accepted. */
export function applyPagePatch(input:string,patch:WebsitePatch,url:string):string {
  let html=input.replace(/<script id="marketing-page-data" type="application\/json">[\s\S]*?<\/script>/g,'');
  if(patch.title) {
    const title=`<title>${escapeHtml(patch.title)}</title>`;
    html=/<title\b/i.test(html)?html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i,()=>title):html.replace(/<\/head>/i,()=>`${title}</head>`);
    for(const key of ['og:title','twitter:title']) html=headTag(html,t=>attr(t,'property')===key || attr(t,'name')===key,'meta',`<meta ${key.startsWith('og:')?'property':'name'}="${key}" content="${escapeHtml(patch.title)}" />`);
  }
  if(patch.description) for(const key of ['description','og:description','twitter:description']) html=headTag(html,t=>attr(t,'property')===key || attr(t,'name')===key,'meta',`<meta ${key.startsWith('og:')?'property':'name'}="${key}" content="${escapeHtml(patch.description)}" />`);
  if(patch.canonical) html=headTag(html,t=>attr(t,'rel').toLowerCase()==='canonical','link',`<link rel="canonical" href="${escapeHtml(patch.canonical)}" />`);
  if(patch.lang) html=html.replace(/<html\b[^>]*>/i,tag=>`${tag.replace(/\s+lang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,'').slice(0,-1)} lang="${escapeHtml(patch.lang!)}">`);
  if(patch.h1) html=/<h1\b/i.test(html)?html.replace(/(<h1\b[^>]*>)[\s\S]*?<\/h1>/i,(_tag,open)=>`${open}${escapeHtml(patch.h1!)}</h1>`):html.replace(/(<main\b[^>]*>)/i,(_tag,open)=>`${open}<h1>${escapeHtml(patch.h1!)}</h1>`);
  if(patch.repairJsonLd) html=html.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,(tag,body)=>{try {JSON.parse(body);return tag;} catch {return '';}});
  const section=enhancementSection(patch);
  if(section) html=html.replace(/<\/main\s*>/i,()=>`${section}</main>`);
  if(patch.structuredData) {
    const fields=readPageFields(html);
    const schema={'@context':'https://schema.org','@type':'WebPage','@id':`${url}#webpage`,url,name:fields.title,description:fields.description,inLanguage:fields.lang || 'en-AU'};
    html=html.replace(/<\/head>/i,()=>`<script data-marketing-schema="true" type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script></head>`);
  }
  // Landing is rendered again by React. It reads the same patch to retain visible edits after mounting.
  return html.replace(/<\/head>/i,()=>`<script id="marketing-page-data" type="application/json">${JSON.stringify(patch).replace(/</g,'\\u003c')}</script></head>`);
}
export function verifyPagePatch(html:string,patch:WebsitePatch):{passed:boolean;checks:string[]} {
  const fields=readPageFields(html),checks:string[]=[],failures:string[]=[];
  for(const key of ['title','description','h1','canonical','lang'] as const) if(patch[key]) (fields[key]===patch[key]?checks:failures).push(`${key}: ${fields[key]===patch[key]?'matches':'does not match'} the saved change`);
  if(patch.summary) (fields.text.includes(patch.summary)?checks:failures).push('Summary is present in the public HTML');
  for(const link of patch.links || []) (tags(html,'a').some(t=>attr(t,'href')===link.href)?checks:failures).push(`Related link: ${link.href}`);
  if(patch.structuredData) {
    const bodies=[...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    const valid=bodies.some(m=>{try {const s=JSON.parse(m[1]);return s['@type']==='WebPage' && s.name===fields.title;} catch{return false;}});
    (valid?checks:failures).push('WebPage structured data is readable');
  }
  if(patch.repairJsonLd) {
    const invalid=[...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].some(m=>{try {JSON.parse(m[1]);return false;} catch{return true;}});
    (invalid?failures:checks).push('Structured data JSON parses');
  }
  return {passed:failures.length===0,checks:[...checks,...failures.map(s=>`FAILED: ${s}`)]};
}
