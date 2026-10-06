import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentStrategy, healthReport, normalizeObservation } from './growth.js';
import { changePercent, importResults, isAIReferrer, measurementPeriod, parseCsv, recordedResults } from './results.js';
import { decryptReportingToken, encryptReportingToken, parseAnalyticsReport, parseSearchReport, searchPropertyMatches } from './google-results.js';
import type { HealthPage, MarketingSite, MarketingTopic } from '../../src/marketingTypes.js';

const stamp=new Date().toISOString();
const site={id:'00000000-0000-4000-8000-000000000001',name:'Owtomate',url:'https://owtomate.com/',country:'AU',profile:null} as MarketingSite;
const page={url:site.url,requestedUrl:site.url,status:200,title:'Owtomate',description:'Useful products',canonical:site.url,robotsMeta:'',xRobotsTag:'',h1:['Owtomate'],wordCount:200,text:'Useful products and guides',links:[],jsonLdTypes:['Organization'],invalidJsonLd:0,imagesWithoutAlt:0,lang:'en',error:null} as HealthPage;
const raw={checkedAt:stamp,pages:[page],robots:{url:'https://owtomate.com/robots.txt',status:200,body:'User-agent: *\nAllow: /\nUser-agent: OAI-SearchBot\nDisallow: /private\nSitemap: https://owtomate.com/sitemap.xml'},sitemaps:[{url:'https://owtomate.com/sitemap.xml',status:200,urls:[site.url],error:null}],gaps:[]};

test('health reports declared bot rules, inaccessible pages and actual errors without inventing index status',()=>{
  const health=healthReport({...raw,pages:[page,{...page,url:'https://owtomate.com/private',requestedUrl:'https://owtomate.com/private',robotsMeta:'noindex',invalidJsonLd:1},{...page,url:'https://owtomate.com/missing',requestedUrl:'https://owtomate.com/missing',status:404},{...page,url:'https://owtomate.com/blocked',requestedUrl:'https://owtomate.com/blocked',status:null,error:'Challenge'}]},site.url);
  assert.equal(health.crawlerAccess.find(b=>b.bot==='OAI-SearchBot')?.blocked,1);
  assert.ok(health.findings.some(f=>f.title==='Page declares noindex'));
  assert.ok(health.findings.some(f=>f.title==='Linked page returns an error' && f.evidence.includes('404')));
  assert.ok(health.findings.some(f=>f.title==='Page could not be checked'));
  assert.ok(health.findings.some(f=>f.title==='Structured data contains invalid JSON'));
  const unknown=healthReport({...raw,robots:{...raw.robots,status:null,body:null}},site.url);
  assert.equal(unknown.crawlerAccess[0].unknown,1);assert.equal(unknown.crawlerAccess[0].allowed,0);
  const missing=healthReport({...raw,robots:{...raw.robots,status:404,body:null}},site.url);
  assert.equal(missing.crawlerAccess[0].allowed,1);
  assert.equal(healthReport({...raw,pages:[{...page,url:'https://evil.owtomate.com/'}]},site.url).pages.length,0);
});
test('content strategy identifies existing topic coverage and preserves stable user action states',()=>{
  const topic={id:'topic',keyword:'job applications',title:'Job applications guide',intent:'learn',priority:'medium',productUrl:site.url,evidenceUrls:[site.url],rationale:'Reader question',status:'planned'} as MarketingTopic;
  const own={...site,health:healthReport({...raw,pages:[page,{...page,url:'https://owtomate.com/blog/job-applications',title:'Job applications',h1:['Job applications'],links:[]}]},site.url)};
  const strategy=contentStrategy(own,[topic],new Map(),[]);assert.ok(strategy.actions.some(a=>a.kind==='refresh'));assert.ok(strategy.actions.some(a=>a.kind==='link'));
  assert.ok(!strategy.actions.some(a=>a.kind==='new' && a.topicId===topic.id));
  const action=strategy.actions[0];assert.equal(contentStrategy(own,[topic],new Map([[action.id,'done']]),[]).actions.find(a=>a.id===action.id)?.status,'done');
});
test('AI samples distinguish mentions, citations, confirmed recommendations and unknown blocked results',()=>{
  const text='Owtomate offers a job application product. Consider Owtomate as an option after checking whether its features fit your needs. Compare the available products carefully before making a decision.';
  const input={provider:'ChatGPT',prompt:'Which job application tools are available in Australia?',observedAt:stamp,status:'complete',answer:text,citations:['https://www.owtomate.com/blog/guide','javascript:alert(1)','https://notowtomate.com/']};
  const observed=normalizeObservation(input,site,'browser');assert.equal(observed.mentioned,true);assert.equal(observed.cited,true);assert.equal(observed.recommendationQuote,null);assert.equal(observed.citations.length,2);
  assert.equal(normalizeObservation({...input,citations:['https://evil.owtomate.com/']},site,'browser').cited,false);
  const blocked=normalizeObservation({...input,status:'blocked',answer:'',citations:[]},site,'browser');assert.equal(blocked.mentioned,null);assert.equal(blocked.cited,null);
  assert.throws(()=>normalizeObservation({...input,recommendationQuote:'Owtomate offers a job application product.'},site,'browser'),/positive recommendation/);
  assert.throws(()=>normalizeObservation({...input,recommendationQuote:'I recommend Owtomate.'},site,'browser'),/exact/);
  assert.equal(normalizeObservation({...input,recommendationQuote:'Consider Owtomate as an option after checking whether its features fit your needs.'},site,'recorded').method,'recorded');
  assert.throws(()=>normalizeObservation({...input,observedAt:'2035-01-01'},site,'browser'),/observation time/);
});
test('CSV imports reject mixed ownership, malformed rows, impossible counts and duplicates',()=>{
  const body={source:'search-console',sourceLabel:'My exported property',periodStart:'2026-01-01',periodEnd:'2026-01-31',csv:'Top pages,Clicks,Impressions,Position\nhttps://owtomate.com/,10,100,4\nhttps://www.owtomate.com/blog/a,0,50,8'};
  const r=importResults(body,site.url);assert.equal(r.clicks,10);assert.equal(r.impressions,150);assert.equal(r.position,16/3);assert.equal(r.method,'import');assert.equal(r.sessions,null);
  assert.throws(()=>importResults({...body,csv:body.csv.replace('https://www.owtomate.com/blog/a','https://evil.owtomate.com/blog/a')},site.url),/this website/);
  assert.throws(()=>importResults({...body,csv:'Page,Clicks,Impressions\nhttps://owtomate.com/,4,2'},site.url),/Check clicks/);
  assert.throws(()=>importResults({...body,csv:'Page,Clicks,Impressions\nhttps://owtomate.com/,1,10\nhttps://owtomate.com/,1,10'},site.url),/unique/);
  assert.throws(()=>parseCsv('Page,Clicks,Clicks\na,1,2'),/headers/);
  assert.throws(()=>parseCsv('a,b\n"unterminated,2'),/unclosed/);
  assert.throws(()=>parseCsv('a,b\n"quoted"x,2'),/characters/);
  assert.deepEqual(parseCsv('a,b\r\n"two\nlines","a""b"'),[['a','b'],['two\nlines','a"b']]);
  const ga=importResults({...body,source:'ga4',csv:'Channel,Source,Sessions\nOrganic Search,google,12\nReferral,chatgpt.com,3\nReferral,chatgpt.com.evil.com,7'},site.url);assert.equal(ga.sessions,22);assert.equal(ga.organicSessions,12);assert.equal(ga.aiSessions,3);assert.equal(ga.leads,null);
});
test('recorded metrics keep unknown separate from zero and reject inconsistent periods and channels',()=>{
  const body={sourceLabel:'Sales ledger',periodStart:'2026-01-01',periodEnd:'2026-01-31',sessions:'0',leads:''};
  const result=recordedResults(body);assert.equal(result.sessions,0);assert.equal(result.leads,null);
  assert.throws(()=>recordedResults({...body,sessions:'12',aiSessions:'13'}),/exceed/);
  assert.throws(()=>measurementPeriod({...body,periodStart:'2026-02-30'}),/completed/);
  assert.throws(()=>recordedResults({...body,sessions:'NaN'}),/finite/);
  assert.equal(changePercent(10,0),null);assert.equal(changePercent(null,10),null);assert.equal(changePercent(12,10),20);
  assert.equal(isAIReferrer('chatgpt.com.evil.com'),false);
});
test('reporting properties and encrypted refresh tokens are scoped and tamper-resistant',()=>{
  assert.equal(searchPropertyMatches('sc-domain:owtomate.com',site.url),true);
  assert.equal(searchPropertyMatches('https://www.owtomate.com/',site.url),true);
  assert.equal(searchPropertyMatches('https://evil.owtomate.com/',site.url),false);
  assert.equal(searchPropertyMatches('sc-domain:evilowtomate.com',site.url),false);
  const previous=process.env.GOOGLE_CLIENT_SECRET;process.env.GOOGLE_CLIENT_SECRET='only-a-test-secret';
  try {const encrypted=encryptReportingToken('only-a-test-token');assert.ok(!encrypted.includes('only-a-test-token'));assert.equal(decryptReportingToken(encrypted),'only-a-test-token');const parts=encrypted.split('.');parts[2]=Buffer.from('tampered').toString('base64url');assert.throws(()=>decryptReportingToken(parts.join('.')));} finally {if(previous===undefined) delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=previous;}
});
test('API reports retain independent source totals and do not reinterpret key events as leads',()=>{
  const period={periodStart:'2026-01-01',periodEnd:'2026-01-28'};
  const search=parseSearchReport({rows:[{clicks:12,impressions:120,position:3}]},{rows:[{keys:[site.url],clicks:4,impressions:80,ctr:0.05,position:3}]},{rows:[]},period,'sc-domain:owtomate.com');assert.equal(search.clicks,12);assert.equal(search.pages[0].clicks,4);
  assert.throws(()=>parseSearchReport({rows:'invalid'},{},{},period,'property'),/invalid/);
  const total={metricHeaders:[{name:'sessions'},{name:'keyEvents'},{name:'ecommercePurchases'},{name:'totalRevenue'}],rows:[{metricValues:[{value:'20'},{value:'2'},{value:'1'},{value:'30.50'}]}],metadata:{timeZone:'Australia/Sydney',currencyCode:'AUD'}};
  const channels={metricHeaders:[{name:'sessions'}],rows:[{dimensionValues:[{value:'Organic Search'}],metricValues:[{value:'12'}]}]};
  const ai={metricHeaders:[{name:'sessions'}],rows:[{dimensionValues:[{value:'chatgpt.com'}],metricValues:[{value:'3'}]}]};
  const ga=parseAnalyticsReport(total,channels,ai,period,'123');assert.equal(ga.sessions,20);assert.equal(ga.organicSessions,12);assert.equal(ga.aiSessions,3);assert.equal(ga.keyEvents,2);assert.equal(ga.leads,null);assert.equal(ga.revenue,30.5);
  assert.throws(()=>parseAnalyticsReport(total,{},ai,period,'123'),/invalid/);
});
