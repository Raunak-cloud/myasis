import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeContent } from './content.js';
import type { MarketingSite, MarketingTopic } from '../../src/marketingTypes.js';

test('marketing drafts use Gemini only, never humanize, and retain failed-review drafts without approving them',async()=>{
  const originalFetch=globalThis.fetch,oldKey=process.env.GEMINI_API_KEY,oldModel=process.env.BLOG_GEMINI_MODEL;
  process.env.GEMINI_API_KEY='marketing-test-key';process.env.BLOG_GEMINI_MODEL='gemini-test';
  const stamp=new Date().toISOString();
  const site={id:'site',url:'https://example.com/',name:'Example',voice:'Helpful',country:'AU',audience:'Buyers',ctaLabel:'View products',ctaUrl:'https://example.com/',profile:{suggestedAudience:'Buyers',productQuotes:[]},research:{researchedAt:stamp,sources:[{ref:'S1',url:'https://example.com/',publisher:'Example',title:'Product',excerpt:'Product details',role:'own',collectedAt:stamp}],keywords:[],gaps:[]}} as unknown as MarketingSite;
  const topic={id:'topic',keyword:'choose software',title:'Choose software',angle:'Useful choices',productUrl:site.url,basis:'website-topic'} as MarketingTopic;
  const article={title:topic.title,slug:'choose-software',metaDescription:'Useful guidance',focusKeyword:topic.keyword,targetSearches:['invented query'],lead:'Our product helps your work. [S1]',sections:[{heading:'Check your needs',paragraphs:[Array(50).fill('Consider your own needs carefully.').join(' ')],bullets:[]},{heading:'Compare the details',paragraphs:[Array(50).fill('Review the source before deciding.').join(' ')],bullets:[]}],takeaways:['Read the product page.']};
  let requests=0;
  try {
    globalThis.fetch=(async(input,init)=>{
      assert.ok(String(input).startsWith('https://generativelanguage.googleapis.com/'));
      const body=JSON.parse(String(init?.body));const reviewing=Boolean(body.generationConfig.responseJsonSchema.properties.approved);
      requests++;return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(reviewing?{approved:false,issues:['Unsupported feature claim.']}:article)}]}}]}),{status:200});
    }) as typeof fetch;
    const result=await writeContent(site,topic,[]);
    assert.equal(requests,6);assert.equal(result.quality.approved,false);assert.deepEqual(result.article.targetSearches,[]);assert.equal(result.model,'gemini-test');
    globalThis.fetch=(async()=>new Response('Invalid key',{status:401})) as typeof fetch;
    await assert.rejects(writeContent(site,topic,[]),/Gemini returned HTTP 401/);
  } finally {globalThis.fetch=originalFetch;if(oldKey===undefined) delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;if(oldModel===undefined) delete process.env.BLOG_GEMINI_MODEL;else process.env.BLOG_GEMINI_MODEL=oldModel;}
});
