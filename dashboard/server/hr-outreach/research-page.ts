import {parseHTML} from 'linkedom';
import {crawlUrl,type PageResponse} from '../job-index/network.js';

const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
export interface PublicPageSlice {offset?:number;linkOffset?:number;query?:string}
/** Agent views and contact evidence use the same public text boundaries. */
export function publicResearchDocument(html:string){
  const {document}=parseHTML(`<html><body>${html.slice(0,3_000_000)}</body></html>`);
  document.querySelectorAll('script,style,noscript,template,[hidden],[aria-hidden="true"]').forEach(node=>node.remove());
  document.querySelectorAll('[style]').forEach(node=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style')??''))node.remove();});
  document.querySelectorAll('title,br,p,li,div,h1,h2,h3,section').forEach(node=>node.appendChild(document.createTextNode('\n')));
  return document;
}
/** Complete, paginated evidence. Navigation-heavy pages cannot silently hide
 * a contact/footer after the first text or link chunk. No recipient selection. */
export function researchPageView(page:PageResponse,options:PublicPageSlice={}) {
  const document=publicResearchDocument(page.text);
  const text=clean(/text\/plain/i.test(page.type)?page.text:document.body?.textContent??document.textContent??'');
  const links=[...document.querySelectorAll('a[href]')].flatMap(anchor=>{
    try{
      const raw=anchor.getAttribute('href')!,url=new URL(raw,page.url);
      if(url.protocol!=='mailto:')crawlUrl(url.href);
      return [{url:url.href,label:clean(anchor.textContent??'').slice(0,200)}];
    }catch{return[];}
  });
  const offset=options.offset??0,linkOffset=options.linkOffset??0;
  const query=options.query?.trim().toLocaleLowerCase();
  const matches:Array<{offset:number;text:string}>=[];
  if(query){let from=offset;while(matches.length<12){const at=text.toLocaleLowerCase().indexOf(query,from);if(at<0)break;
    matches.push({offset:at,text:text.slice(Math.max(0,at-250),at+query.length+350)});from=at+Math.max(1,query.length);}}
  return {url:page.url,title:clean(document.querySelector('title')?.textContent??''),
    ...(query?{query:options.query,matches,nextMatchOffset:matches.length===12?matches.at(-1)!.offset+query.length:null}
      :{text:text.slice(offset,offset+10000),offset,totalCharacters:text.length,nextOffset:offset+10000<text.length?offset+10000:null}),
    links:links.slice(linkOffset,linkOffset+100),linkOffset,totalLinks:links.length,nextLinkOffset:linkOffset+100<links.length?linkOffset+100:null};
}
