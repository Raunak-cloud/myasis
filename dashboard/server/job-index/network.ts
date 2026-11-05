import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createRequire } from 'node:module';
import { canonicalUrl } from './extract.js';
import { parseHTML } from 'linkedom';

export const AGENT = 'OwtomateJobIndex/1.0 (+https://owtomate.com)';
export class CrawlBlocked extends Error {}
export class CrawlDeferred extends Error { readonly waitMs:number; constructor(waitMs: number,message='Host rate limit or crawl delay; queued for later.') { super(message);this.waitMs=waitMs; } }
interface Robots { isAllowed:(url:string,agent:string)=>boolean|undefined;getCrawlDelay:(agent:string)=>number|undefined }
const robotsParser=createRequire(import.meta.url)('robots-parser') as (url:string,text:string)=>Robots;
export function publicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168||b===0||b===2) || a===100&&b>=64&&b<=127 || a===198&&(b===18||b===19||b===51&&c===100) || a===203&&b===0&&c===113);
}
export function crawlUrl(raw: string): URL {
  const u = new URL(canonicalUrl(raw));
  if (isIP(u.hostname) || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$|^(?:metadata|instance-data)\./i.test(u.hostname)) throw new CrawlBlocked('Private and non-public destinations are excluded.');
  if (/\/(?:login|sign[-_]?in|register|applications?|apply)(?:[/?]|$)/i.test(u.pathname)) throw new CrawlBlocked('Account and application forms are excluded from indexing.');
  return u;
}
export interface PageResponse { url: string; status: number; type: string; text: string; retryAfter: string | null; location?:string }
/** Match both Node lookup contracts, including family auto-selection's all mode. */
export const pinnedLookup=(address:string):LookupFunction=>(_host,options,callback)=>{
  if(options.all)callback(null,[{address,family:4}]);else callback(null,address,4);
};

/** A CAPTCHA library/configuration on a public careers page is not a challenge. */
function accessChallenge(page:PageResponse):boolean {
  if(!/html/.test(page.type))return false;
  const {document}=parseHTML(`<html><body>${page.text}</body></html>`);
  if(document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'))return true;
  document.querySelectorAll('script,style,noscript,template,[hidden]').forEach(n=>n.remove());
  const visible=(document.body?.textContent??document.textContent??'').replace(/\s+/g,' ');
  return /verify (?:that )?you are human|access denied|please (?:complete|solve) (?:the )?(?:captcha|security check)/i.test(visible);
}

/** Resolve, validate and pin each redirect's DNS target; never forward cookies or credentials. */
export async function publicRequest(raw: string, init: { body?: string; signal?: AbortSignal } = {}): Promise<PageResponse> {
  const u = crawlUrl(raw); const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]);
  signal.throwIfAborted();
  const addresses = await lookup(u.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new CrawlBlocked('Destination resolved outside the public internet.');
  // Public Workday search uses POST; no other crawler request may post data.
  if (init.body && !/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(u.hostname)) throw new CrawlBlocked('Only a public Workday listing search can receive a query body.');
  if (init.body && !/^\/wday\/cxs\/[\w-]+\/[\w-]+\/jobs$/.test(u.pathname)) throw new CrawlBlocked('Only the public listing search endpoint is accepted.');
  return new Promise<PageResponse>((resolve, reject) => {
    const req = request(u, { method: init.body ? 'POST' : 'GET', family: 4, signal, headers: { 'User-Agent': AGENT, Accept: 'text/html,application/json,application/xml,text/plain', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, lookup: pinnedLookup(addresses[0].address) }, res => {
      const status = res.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) {
        res.resume();
        if (!res.headers.location) { reject(new CrawlBlocked('Redirect without a destination.')); return; }
        resolve({url:u.href,status,type:'',text:'',retryAfter:null,location:new URL(res.headers.location,u).href});return;
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      if (status>=200&&status<300 && !/json|html|xml|text\/plain/.test(type)) { res.destroy(); reject(new CrawlBlocked('Unsupported public page type.')); return; }
      let size=0; const chunks: Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{ size+=chunk.length; if(size>3_000_000) res.destroy(new CrawlBlocked('Page exceeds the 3 MB indexing limit.')); else chunks.push(chunk); });
      res.on('error',reject); res.on('end',()=>resolve({url:u.href,status,type,text:Buffer.concat(chunks).toString('utf8'),retryAfter:typeof res.headers['retry-after']==='string'?res.headers['retry-after']:null}));
    });
    req.on('error',reject); if(init.body)req.write(init.body); req.end();
  });
}

/** Process-local host pacing plus durable single-worker ownership in the index DB. */
export class PublicCrawler {
  private robots = new Map<string, { parser: Robots; until: number }>();
  private next = new Map<string, number>();
  requests = 0;
  readonly maxRequests:number;private readonly read:typeof publicRequest;
  constructor(read=publicRequest,maxRequests=160) {this.read=read;this.maxRequests=maxRequests;}
  private async request(url: string, init?: {body?:string;signal?:AbortSignal}): Promise<PageResponse> {
    if (++this.requests>this.maxRequests) throw new CrawlDeferred(60_000);
    return this.read(url,init);
  }
  async get(raw: string, init?: {body?:string;signal?:AbortSignal},redirects=0): Promise<PageResponse> {
    const u=crawlUrl(raw); let rules=this.robots.get(u.origin);
    if(!rules || rules.until<Date.now()) {
      let r=await this.request(`${u.origin}/robots.txt`, {signal:init?.signal});
      for(let n=0;r.location&&n<5;n++)r=await this.request(crawlUrl(r.location).href,{signal:init?.signal});
      if(r.location)throw new CrawlBlocked('Robots redirect limit reached.');
      if(r.status>=200&&r.status<300&&/<html\b|<!doctype/i.test(r.text))throw new CrawlBlocked('The robots address returned an HTML access page.');
      if(r.status===429 || r.status>=500)throw new CrawlDeferred(15*60_000);
      if(r.status===401 || r.status===403)throw new CrawlBlocked('The host refuses crawler access.');
      if(!(r.status>=200&&r.status<300) && ![404,410].includes(r.status))throw new CrawlBlocked('Robots policy could not be verified.');
      rules={parser:robotsParser(`${u.origin}/robots.txt`,r.status===404||r.status===410?'':r.text),until:Date.now()+6*3600_000}; this.robots.set(u.origin,rules);
    }
    if(rules.parser.isAllowed(u.href,AGENT)!==true)throw new CrawlBlocked('Robots policy excludes this address.');
    const delay=Math.max(1500,(rules.parser.getCrawlDelay(AGENT)??0)*1000);
    const wait=(this.next.get(u.origin)??0)-Date.now();
    if(wait>5000)throw new CrawlDeferred(wait);
    if(wait>0)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,wait);function done(){init?.signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(init?.signal?.reason);}if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});});
    this.next.set(u.origin,Date.now()+delay);
    const page=await this.request(u.href,init);
    if(page.location){if(redirects>=4)throw new CrawlBlocked('Page redirect limit reached.');return this.get(page.location,{signal:init?.signal},redirects+1);}
    if(page.status===429) { const retry=Number(page.retryAfter); const waitMs=Number.isFinite(retry)&&retry>0?Math.min(retry*1000,24*3600_000):15*60_000; this.next.set(u.origin,Date.now()+waitMs); throw new CrawlDeferred(waitMs); }
    if([401,403].includes(page.status)||accessChallenge(page))throw new CrawlBlocked('The public source requires access or human verification.');
    // Don't index or follow an HTML login wall that happens to return 200.
    if(/text\/html/.test(page.type)&&/<input\b[^>]*type\s*=\s*["']password["']/i.test(page.text)&&!/"@type"\s*:\s*"JobPosting"/.test(page.text))throw new CrawlBlocked('Sign-in page excluded.');
    return page;
  }
  /** Adapter keeps existing employer parsers behind the same network policy. */
  fetch: typeof fetch = async (input, init) => {
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(init?.method && !['GET','POST'].includes(init.method))throw new CrawlBlocked('Only public listing reads are supported.');
    const page=await this.get(url,{...(typeof init?.body==='string'?{body:init.body}:{}),...(init?.signal?{signal:init.signal}:{})});
    return new Response(page.text,{status:page.status,headers:{'content-type':page.type}});
  };
}
