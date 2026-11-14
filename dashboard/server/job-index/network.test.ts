import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer,connect,type AddressInfo } from 'node:net';
import { CrawlBlocked, CrawlDeferred, PublicCrawler, crawlUrl, publicIPv4, pinnedLookup, type PageResponse } from './network.js';
import {canonicalUrl} from './extract.js';

test('pinned DNS connects through the real Node transport with both lookup callback modes',async()=>{
  // The trusted lookup helper uses a loopback fixture here. publicRequest's
  // independent public-address checks still reject loopback in production.
  const server=createServer(s=>s.end('fixture response'));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const modes:boolean[]=[];
  try {for(const autoSelectFamily of [true,false]) {
    const body=await new Promise<string>((resolve,reject)=>{
      let text='';const socket=connect({host:'pinned.fixture.test',port:(server.address() as AddressInfo).port,autoSelectFamily,lookup:(host,options,callback)=>{modes.push(options.all===true);pinnedLookup('127.0.0.1')(host,options,callback);}});
      socket.setTimeout(2000,()=>socket.destroy(Error('Fixture transport timed out')));socket.on('data',b=>text+=b);socket.on('end',()=>resolve(text));socket.on('error',reject);
    });assert.equal(body,'fixture response');
  }assert.deepEqual(modes,[true,false]);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('crawler excludes private, metadata, IP literal and credential form addresses',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.31.1.2','192.168.1.1','169.254.169.254','100.64.0.2','198.18.0.1','0.0.0.0','224.1.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('1.1.1.1'),true);
  for(const url of ['https://127.0.0.1/jobs','https://2130706433/jobs','https://[::1]/jobs','https://metadata.google.internal/jobs','https://host.local/jobs','https://user:password@public.org/jobs','http://public.org/jobs','https://public.org/apply','https://public.org/login'])assert.throws(()=>crawlUrl(url),url);
});
const response=(url:string,text:string,status=200,location?:string):PageResponse=>({url,text,status,type:'text/html',retryAfter:null,...(location?{location}:{})});
test('employer feed adapter preserves manual PageUp redirects and AWS challenge headers after robots checks',async()=>{
 const calls:string[]=[];
 const c=new PublicCrawler(async url=>{
  calls.push(url);
  if(url.endsWith('/robots.txt'))return response(url,'User-agent: *\nAllow: /');
  if(url.includes('pageuppeople.com'))return response(url,'',302,'https://careers.publisher.org/jobs/search');
  return {...response(url,'Publisher JS verification',202),verification:'challenge'};
 });
 const moved=await c.fetch('https://careers.pageuppeople.com/539/caw/en/search/',{redirect:'manual'});
 assert.equal(moved.status,302);assert.equal(moved.headers.get('location'),'https://careers.publisher.org/jobs/search');
 assert.equal(calls.some(url=>url.includes('publisher.org')),false,'the connector must see and verify the redirect');
 const challenge=await c.fetch('https://careers.publisher.org/jobs/search',{redirect:'manual'});
 assert.equal(challenge.status,202);assert.equal(challenge.headers.get('x-amzn-waf-action'),'challenge');
 assert.ok(calls.indexOf('https://careers.publisher.org/robots.txt')<calls.indexOf('https://careers.publisher.org/jobs/search'));
});
test('ordinary crawling never indexes a silent AWS challenge or interactive CAPTCHA',async()=>{
 for(const verification of ['challenge','captcha']){
  const c=new PublicCrawler(async url=>url.endsWith('/robots.txt')?response(url,'User-agent: *\nAllow: /'):{...response(url,'Verification',202),verification});
  await assert.rejects(c.get('https://careers.publisher.org/jobs/search'),CrawlBlocked);
 }
});
test('publisher slash redirects preserve their transport URL while vacancy identities still deduplicate',async()=>{
 const calls:string[]=[];const slash='https://public.org/jobs/123/?utm_source=public-board';
 const c=new PublicCrawler(async url=>{calls.push(url);if(url.endsWith('/robots.txt'))return response(url,'User-agent: *\nAllow: /');if(url==='https://public.org/jobs/123')return response(url,'',301,slash);if(url===slash)return response(url,'<h1>Published vacancy</h1>');throw Error('Unexpected URL rewrite');});
 const page=await c.get('https://public.org/jobs/123');assert.equal(page.url,slash);assert.match(page.text,/Published vacancy/);
 assert.deepEqual(calls,['https://public.org/robots.txt','https://public.org/jobs/123',slash]);
 assert.equal(canonicalUrl(page.url),canonicalUrl('https://public.org/jobs/123'));
 assert.throws(()=>crawlUrl('https://public.org/apply/'));assert.throws(()=>crawlUrl('https://public.org/jobs/?token=secret'));
});
test('robots exclusions prevent page reads and access challenges are never bypassed',async()=>{
  const calls:string[]=[];const c=new PublicCrawler(async url=>{calls.push(url);return response(url,'User-agent: *\nDisallow: /private');});
  await assert.rejects(()=>c.get('https://public.org/private/jobs'),CrawlBlocked);assert.equal(calls.length,1);
  const blocked=new PublicCrawler(async url=>response(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'Verify you are human'));
  await assert.rejects(()=>blocked.get('https://public.org/jobs'),CrawlBlocked);
});

test('public vacancies remain readable when scripts configure CAPTCHA or JSON mentions it',async()=>{
  for(const [type,text] of [
    ['text/html','<html><body><script>window.settings={GOOGLE_RECAPTCHA_ENDPOINT:"https://www.recaptcha.net/"}</script><h1>Engineering careers</h1></body></html>'],
    ['application/json',JSON.stringify({jobs:[{description:'Develop CAPTCHA detection software.'}]})],
  ]) {
    const c=new PublicCrawler(async url=>url.endsWith('/robots.txt')?response(url,'User-agent: *\nAllow: /'):{...response(url,text),type});
    assert.equal((await c.get('https://public.org/jobs')).text,text);
  }
  const c=new PublicCrawler(async url=>response(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'<html><body>Please complete the CAPTCHA to continue.</body></html>'));
  await assert.rejects(()=>c.get('https://public.org/jobs'),CrawlBlocked);
});
test('redirect destinations receive their own robots policy before any job read',async()=>{
  const calls:string[]=[];const c=new PublicCrawler(async url=>{
    calls.push(url);if(url==='https://one.org/robots.txt')return response(url,'User-agent: *\nAllow: /');
    if(url==='https://one.org/jobs')return response(url,'',302,'https://two.org/jobs');
    return response(url,'User-agent: *\nDisallow: /');
  });
  await assert.rejects(()=>c.get('https://one.org/jobs'),CrawlBlocked);assert.deepEqual(calls,['https://one.org/robots.txt','https://one.org/jobs','https://two.org/robots.txt']);
});
test('robots outages, long host delays and request ceilings defer instead of hiding failures',async()=>{
  await assert.rejects(()=>new PublicCrawler(async url=>response(url,'',503)).get('https://public.org/jobs'),CrawlDeferred);
  const c=new PublicCrawler(async url=>response(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /\nCrawl-delay: 60':'<h1>Jobs</h1>'));
  await c.get('https://public.org/jobs');await assert.rejects(()=>c.get('https://public.org/jobs/next'),CrawlDeferred);
  const limited=new PublicCrawler(async url=>response(url,'User-agent: *\nAllow: /'),1);await assert.rejects(()=>limited.get('https://public.org/jobs'),CrawlDeferred);
});
