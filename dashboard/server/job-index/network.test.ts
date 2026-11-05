import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrawlBlocked, CrawlDeferred, PublicCrawler, crawlUrl, publicIPv4, type PageResponse } from './network.js';

test('crawler excludes private, metadata, IP literal and credential form addresses',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.31.1.2','192.168.1.1','169.254.169.254','100.64.0.2','198.18.0.1','0.0.0.0','224.1.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('1.1.1.1'),true);
  for(const url of ['https://127.0.0.1/jobs','https://2130706433/jobs','https://[::1]/jobs','https://metadata.google.internal/jobs','https://host.local/jobs','https://user:password@public.org/jobs','http://public.org/jobs','https://public.org/apply','https://public.org/login'])assert.throws(()=>crawlUrl(url),url);
});
const response=(url:string,text:string,status=200,location?:string):PageResponse=>({url,text,status,type:'text/html',retryAfter:null,...(location?{location}:{})});
test('robots exclusions prevent page reads and access challenges are never bypassed',async()=>{
  const calls:string[]=[];const c=new PublicCrawler(async url=>{calls.push(url);return response(url,'User-agent: *\nDisallow: /private');});
  await assert.rejects(()=>c.get('https://public.org/private/jobs'),CrawlBlocked);assert.equal(calls.length,1);
  const blocked=new PublicCrawler(async url=>response(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'Verify you are human'));
  await assert.rejects(()=>blocked.get('https://public.org/jobs'),CrawlBlocked);
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
