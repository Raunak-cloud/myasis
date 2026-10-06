import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** Campaign ownership permits the www alias, never arbitrary subdomains or parent domains. */
export function samePublicSite(actual:string,expected:string):boolean {
  try {const a=new URL(actual),b=new URL(expected);return ['http:','https:'].includes(a.protocol) && ['http:','https:'].includes(b.protocol) && a.hostname.replace(/^www\./,'')===b.hostname.replace(/^www\./,'');} catch{return false;}
}

/** Public-address boundary for customer-supplied sites and every browser request. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Only globally routed IPv6 unicast, excluding documentation and transition ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(address) && !/^2001:0*(db8|0|10|20):|^2002:/.test(address);
}

export function publicWebsiteUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || isIP(url.hostname.replace(/[\[\]]/g, '')) || /(^localhost$|\.(local|internal|test|localhost)$)/i.test(url.hostname)) throw new Error('Enter a public HTTPS website without a port or sign-in details.');
  return url.origin + '/';
}

export async function assertPublicUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Only public web addresses are allowed.');
  const host = url.hostname.replace(/[\[\]]/g, '');
  if (/^localhost$|\.(local|internal|test|localhost)$/i.test(host)) throw new Error('Private websites are not allowed.');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error('Private or reserved network addresses are not allowed.');
}

/** Text/API requests pin the checked DNS address and validate every redirect. */
export async function publicFetch(raw: string, options: {method?:string;body?:string;headers?:Record<string,string>;timeoutMs?:number}={}, redirects=0): Promise<Response> {
  if(redirects>5) throw new Error('Too many website redirects.');
  await assertPublicUrl(raw);
  const url=new URL(raw), host=url.hostname.replace(/[\[\]]/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new Error('Private network address refused.');
  const selected=addresses[0];
  const response=await new Promise<Response>((resolve,reject)=>{
    const requestOptions={
      method:options.method || 'GET',headers:options.headers,
      lookup:((_host:unknown,opts:{all?:boolean},callback:(error:Error|null,address:unknown,family?:number)=>void)=>opts.all?callback(null,[selected]):callback(null,selected.address,selected.family)) as never,
    };
    const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,requestOptions,res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024) req.destroy(new Error('Website text response is too large.'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{
        const headers=new Headers();for(const [key,value] of Object.entries(res.headers)) if(value!=null) headers.set(key,Array.isArray(value)?value.join(', '):value);
        const status=res.statusCode || 502;resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
      });
    });
    const timeout=setTimeout(()=>req.destroy(new Error('Website request timed out.')),options.timeoutMs || 15_000);
    req.once('close',()=>clearTimeout(timeout));req.on('error',reject);
    if(options.body) req.write(options.body);req.end();
  });
  if([301,302,303,307,308].includes(response.status) && response.headers.get('location')) {
    const next=new URL(response.headers.get('location')!,url);
    const changed=next.origin!==url.origin;
    const headers={...options.headers};if(changed) for(const key of Object.keys(headers)) if(/authorization|cookie/i.test(key)) delete headers[key];
    return publicFetch(next.href,{...options,headers,...(response.status===303?{method:'GET',body:undefined}:{})},redirects+1);
  }
  return response;
}
