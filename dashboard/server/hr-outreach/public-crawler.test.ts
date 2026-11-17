import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HrPublicCrawler} from './public-crawler.js';
import {CrawlBlocked,PublicCrawler,PublicVerificationRequired,type PageResponse} from '../job-index/network.js';
const page=(url:string,text='<h1>Recruitment</h1>',status=200):PageResponse=>({url,text,status,type:'text/html',retryAfter:null});
test('only a genuine verification response triggers one shared browser recovery',async()=>{
 let renders=0;const crawler=new HrPublicCrawler({get:async url=>{throw new PublicVerificationRequired(page(url,'Please complete the CAPTCHA.',403));}},async(url,options)=>{renders++;await options.authorize(url);return page(url,'<h1>Careers</h1><p>Recruitment careers@employer.org</p>');});
 const [a,b]=await Promise.all([crawler.get('https://employer.org/careers'),crawler.get('https://employer.org/careers#contact')]);assert.equal(a,b);assert.equal(renders,1);assert.deepEqual(crawler.events.map(e=>e.kind),['verification_started','verification_cleared']);
});
test('robots refusals, ordinary 403s and login pages never invoke CapMonster recovery',async()=>{
 for(const scenario of ['robots','denied','login']){
  let renders=0;const primary=new PublicCrawler(async url=>url.endsWith('/robots.txt')?page(url,scenario==='robots'?'User-agent: *\nDisallow: /':'User-agent: *\nAllow: /'):page(url,scenario==='login'?'<input type="password">':'Access denied',scenario==='denied'?403:200));
  const crawler=new HrPublicCrawler(primary,async url=>{renders++;return page(url);});await assert.rejects(crawler.get('https://employer.org/careers'),CrawlBlocked);assert.equal(renders,0,scenario);
 }
});
test('plain content and CAPTCHA library references do not trigger recovery or a purchase',async()=>{
 let renders=0;const primary=new PublicCrawler(async url=>page(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'<h1>Careers</h1><script src="https://www.google.com/recaptcha/api.js"></script>'));
 const crawler=new HrPublicCrawler(primary,async url=>{renders++;return page(url);});await crawler.get('https://employer.org/careers');assert.equal(renders,0);
});
test('failed verification is recorded accurately, cached per lookup and never treated as a usable page',async()=>{
 let renders=0;const crawler=new HrPublicCrawler({get:async url=>{throw new PublicVerificationRequired(page(url));}},async()=>{renders++;throw Error('SECRET_PROVIDER_PAYLOAD');});
 await assert.rejects(crawler.get('https://employer.org/careers'),/could not finish/);await assert.rejects(crawler.get('https://employer.org/careers'));assert.equal(renders,1);assert.doesNotMatch(JSON.stringify(crawler.events),/SECRET_PROVIDER_PAYLOAD/);assert.equal(crawler.events.at(-1)?.kind,'verification_failed');
});
test('temporary ordinary page failures can be retried without invoking the paid solver',async()=>{
 let reads=0,renders=0;const crawler=new HrPublicCrawler({get:async url=>{if(++reads===1)throw Error('Temporary network failure');return page(url);}},async url=>{renders++;return page(url);});
 await assert.rejects(crawler.get('https://employer.org/careers'),/Temporary/);await crawler.get('https://employer.org/careers');assert.equal(reads,2);assert.equal(renders,0);
});

test('inline Cloudflare reaches browser recovery and unsupported verification is reported precisely',async()=>{
 let renders=0;
 const primary=new PublicCrawler(async url=>page(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'<title>Just a moment...</title><script>window._cf_chl_opt={};const path="/cdn-cgi/challenge-platform/h/g/";</script>',url.endsWith('/robots.txt')?200:403));
 const crawler=new HrPublicCrawler(primary,async()=>{renders++;throw new CrawlBlocked('Security verification is not supported by the configured solver.');});
 await assert.rejects(crawler.get('https://employer.org/careers'),/not supported/);
 assert.equal(renders,1);assert.equal(crawler.events.at(-1)?.code,'verification_unsupported');
});

test('anonymous HR reads permit optional account widgets without changing the indexer or private URL rules',async()=>{
 const read=async(url:string)=>page(url,url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':'<html><body><main><h1>Employer careers</h1><p>Recruitment talent@employer.org</p></main><aside><input type="password"></aside></body></html>');
 await assert.rejects(new PublicCrawler(read).get('https://employer.org/careers'),/Sign-in/);
 let renders=0;const crawler=new HrPublicCrawler(new PublicCrawler(read,40,{allowLoginWidgets:true}),async url=>{renders++;return page(url);});
 assert.match((await crawler.get('https://employer.org/careers')).text,/talent@employer.org/);assert.equal(renders,0);
 await assert.rejects(async()=>crawler.get('https://employer.org/login'),/Account/);
 await assert.rejects(async()=>crawler.get('https://127.0.0.1/private'));
});

test('agent-requested rendering retains real public DOM for later verification and reuses no account session',async()=>{
 let renders=0;const crawler=new HrPublicCrawler({get:async url=>page(url,'<h1>Employer</h1><script src="contacts.js"></script>')},async(url,options)=>{renders++;await options.authorize(url);return page(url,'<h1>Employer careers</h1><a href="mailto:talent@employer.org">Recruitment</a>');});
 const rendered=await crawler.renderPublicPage('https://employer.org/careers');
 assert.match(rendered.text,/talent@employer.org/);assert.equal(await crawler.get(rendered.url),rendered);assert.equal(renders,1);
 assert.deepEqual(crawler.events.map(event=>event.kind),['render_started','render_completed']);
});
