import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWeeklyRun, ownedLink, publicationProblem, sameTopic, validateArticle } from './policy.js';
import { contentBrief, curateTopics, exportArticle } from './content.js';
import { publicationSourceProblem } from './worker.js';
import type { MarketingArticle, MarketingResearch, MarketingSite, WebsiteProfile } from '../../src/marketingTypes.js';

const stamp=new Date().toISOString();
const source={ref:'S1',publisher:'example.com',url:'https://example.com/',title:'Products',published:null,excerpt:'Our product helps organise the work.',collectedAt:stamp,role:'own' as const};
const research:MarketingResearch={researchedAt:stamp,sources:[source],keywords:[{phrase:'organise my work',engines:['Google'],evidenceUrls:['https://google.com/search?q=organise']}],competitors:[],searches:[],gaps:[],cost:'estimated $0.01',collected:1,retained:1,auditActions:[]};
const profile:WebsiteProfile={name:'Example',sells:'work organisation software',suggestedAudience:'A suggested audience',scannedAt:stamp,productQuotes:[],gaps:[],pages:[{url:'https://example.com/',title:'Example',text:'Products',description:'',h1:[],ctas:[],links:[],products:[]}]};
const site={url:'https://example.com/',publisher:'owtomate',profileConfirmed:true,research,profile,ctaUrl:'https://example.com/signup',ctaLabel:'Try it'} as MarketingSite;
const article:MarketingArticle={title:'Organise your work',slug:'organise-your-work',metaDescription:'A practical guide.',focusKeyword:'organise my work',targetSearches:[],lead:'Our product helps organise the work. [S1]',sections:[{heading:'Make a plan',paragraphs:[Array(80).fill('Practical advice to consider carefully.').join(' ')],bullets:[]},{heading:'Check the details',paragraphs:[Array(50).fill('Review your situation before deciding.').join(' ')],bullets:[]}],takeaways:['Choose what suits your workflow.']};

test('weekly local-time schedule handles normal slots, spring gaps and repeated autumn time',()=>{
  assert.equal(nextWeeklyRun(new Date('2026-10-06T00:00Z'),0,'08:00','Australia/Sydney').toISOString(),'2026-10-11T21:00:00.000Z');
  assert.equal(nextWeeklyRun(new Date('2026-10-03T12:00Z'),6,'02:30','Australia/Sydney').toISOString(),'2026-10-03T16:00:00.000Z');
  const first=nextWeeklyRun(new Date('2027-04-03T12:00Z'),6,'02:30','Australia/Sydney');
  assert.equal(first.toISOString(),'2027-04-03T15:30:00.000Z');
  assert.ok(nextWeeklyRun(new Date(first.getTime()+60000),6,'02:30','Australia/Sydney').getTime()>first.getTime()+6*86400_000);
  assert.throws(()=>nextWeeklyRun(new Date(),1,'25:00','UTC'));
});
test('only confirmed admins with a fresh Owtomate campaign can publish',()=>{
  assert.equal(publicationProblem(site,true,'https://example.com'),null);
  assert.ok(publicationProblem(site,false,'https://example.com'));
  assert.ok(publicationProblem({...site,profileConfirmed:false},true,'https://example.com'));
  assert.ok(publicationProblem({...site,research:{...research,researchedAt:'invalid'}},true,'https://example.com'));
  assert.ok(publicationProblem({...site,research:{...research,researchedAt:'2020-01-01'}},true,'https://example.com'));
  assert.ok(publicationProblem(site,true,'https://another.com'));
});
test('old draft evidence cannot inherit freshness from a newer site research run',()=>{
  assert.equal(publicationSourceProblem({gatheredAt:stamp,sources:[source]}),null);
  assert.ok(publicationSourceProblem({gatheredAt:stamp,sources:[{collectedAt:'2020-01-01'}]}));
  assert.ok(publicationSourceProblem({gatheredAt:stamp,sources:[{}]}));
});
test('forged citations, truncated articles and performance guarantees fail validation',()=>{
  assert.equal(validateArticle(article,['S1']).slug,article.slug);
  assert.throws(()=>validateArticle({...article,lead:'Wrong citation [S99]'},['S1']));
  assert.throws(()=>validateArticle({...article,sections:[]},['S1']));
  assert.throws(()=>validateArticle({...article,lead:'Guaranteed conversions [S1]'},['S1']));
});
test('planner rejects invented evidence, repeated topics and external product URLs',()=>{
  const raw={title:'Organise a useful workflow',keyword:'organise my work',angle:'Practical planning',intent:'buy',productUrl:'https://other.com/',evidenceUrls:[source.url]};
  const topics=curateTopics([raw,{...raw,title:'Another title'},{...raw,keyword:'invented',evidenceUrls:['https://fake.com/']}],profile,research,[],site.url);
  assert.equal(topics.length,1);assert.equal(topics[0].basis,'search-suggestion');assert.equal(topics[0].productUrl,site.url);
  assert.ok(topics[0].rationale.includes('unmeasured'));
  assert.equal(curateTopics([raw],profile,research,[raw.title],site.url).length,0);
  assert.equal(curateTopics([{...raw,title:'Write in thirty minutes',angle:'Save 30-60 minutes per task'}],profile,research,[],site.url).length,0);
  assert.equal(curateTopics([{...raw,title:'Automate without breaking rules'}],profile,research,[],site.url).length,0);
  assert.equal(curateTopics([{...raw,angle:'Sending more applications changes your odds'}],profile,research,[],site.url).length,0);
  assert.ok(sameTopic('A useful workflow organisation guide','Useful workflow organisation'));
});
test('exports escape model markup and preserve the real configured CTA',()=>{
  const topic=curateTopics([{title:article.title,keyword:article.focusKeyword,angle:'Guidance',intent:'learn',productUrl:site.url,evidenceUrls:[source.url]}],profile,research,[],site.url)[0];
  const brief=contentBrief(site,topic);
  assert.equal(brief.marketing?.ctaUrl,site.ctaUrl);assert.equal(brief.searches[0].rank,0);
  const html=exportArticle({...article,title:'<script>alert(1)</script>'},brief,'html');
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('https://example.com/signup'));
  assert.throws(()=>ownedLink('https://other.com/buy',site.url));assert.throws(()=>ownedLink('/logout',site.url));
});
