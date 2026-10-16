import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPagePatch, editablePath, pageSourceHash, readPageFields, verifyPagePatch } from './page-edits.js';
import { websiteAccess } from './execution.js';
import type { MarketingSite, WebsitePatch } from '../../src/marketingTypes.js';

const origin='https://owtomate.com';
const source='<!doctype html><html><head><title>Original</title><meta name="description" content="Original description"><meta name="robots" content="noindex"><script type="application/ld+json">{"@type":"Organization","name":"Original"}</script><script type="application/ld+json">broken</script></head><body><main><h1 class="hero">Original heading</h1><p>Original facts and information for visitors.</p></main></body></html>';
test('write access requires the built-in connection, current origin and an admin',()=>{
  const site={url:`${origin}/`,publisher:'owtomate'} as MarketingSite;
  assert.equal(websiteAccess(site,true,origin).available,true);
  assert.equal(websiteAccess(site,false,origin).available,false);
  assert.equal(websiteAccess({...site,url:'https://elsewhere.com/'},true,origin).available,false);
  assert.equal(websiteAccess({...site,publisher:'export'},true,origin).available,false);
  for(const path of ['/','/blog','/blog/helpful-guide','/automate-job-applications-australia']) assert.equal(editablePath(origin+path,origin),path);
  for(const path of ['/privacy','/terms','/api/config','/?tab=marketing','/blog/../api/auth','/blog/%61','/blog/draft?preview=1']) assert.equal(editablePath(origin+path,origin),null);
  assert.equal(editablePath('https://evil.owtomate.com/blog/a',origin),null);
});
test('page edits change delivered content while preserving indexing policy and valid schema',()=>{
  const patch:WebsitePatch={title:'Practical guide',description:'Facts about this specific guide.',h1:'A useful guide',canonical:`${origin}/blog/a`,lang:'en-AU',summary:'Original facts and information for visitors.',links:[{text:'More guidance',href:`${origin}/blog/b`}],structuredData:true,repairJsonLd:true};
  const html=applyPagePatch(source,patch,`${origin}/blog/a`);
  const fields=readPageFields(html);
  assert.equal(fields.title,patch.title);assert.equal(fields.description,patch.description);assert.equal(fields.h1,patch.h1);
  assert.match(html,/name="robots" content="noindex"/);
  assert.match(html,/"@type":"Organization"/);assert.ok(!html.includes('>broken</script>'));
  assert.match(html,/<a href="https:\/\/owtomate.com\/blog\/b">More guidance<\/a>/);
  assert.equal(verifyPagePatch(html,patch).passed,true);
  assert.equal(verifyPagePatch(source,patch).passed,false);
});
test('untrusted text cannot inject markup, terminate JSON scripts or act as replacement patterns',()=>{
  const malicious='A $& $1 </script><img src=x onerror=alert(1)> & "quote"';
  const patch:WebsitePatch={title:malicious,h1:malicious,description:malicious,summary:malicious,structuredData:true};
  const html=applyPagePatch(source,patch,`${origin}/`);
  assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('</script><img'));
  assert.equal(readPageFields(html).title,malicious);assert.equal(readPageFields(html).h1,malicious);
  const embedded=html.match(/<script id="marketing-page-data" type="application\/json">([\s\S]*?)<\/script>/)![1];
  assert.equal(JSON.parse(embedded).summary,malicious);
  assert.equal(verifyPagePatch(html,patch).passed,true);
});
test('source fingerprints detect page and policy edits while ignoring analytics build scripts',()=>{
  assert.equal(pageSourceHash(source),pageSourceHash(source.replace('</head>','<script src="/analytics-v2.js"></script></head>')));
  assert.notEqual(pageSourceHash(source),pageSourceHash(source.replace('Original facts','Changed facts')));
  assert.notEqual(pageSourceHash(source),pageSourceHash(source.replace('content="noindex"','content="index"')));
  assert.notEqual(pageSourceHash(source),pageSourceHash(source.replace('"@type":"Organization"','"@type":"WebPage"')));
});
test('real guide template accepts edits without damaging its article or navigation',()=>{
  const guide=readFileSync(new URL('../../automate-job-applications-australia.html',import.meta.url),'utf8');
  const original=readPageFields(guide),patch:WebsitePatch={title:'Updated guide title',description:'An accurate description of the existing guide.',structuredData:true,links:[{href:`${origin}/blog`,text:'Job search guides'}]};
  const html=applyPagePatch(guide,patch,`${origin}/automate-job-applications-australia`);
  assert.equal(readPageFields(html).h1,original.h1);
  assert.ok(readPageFields(html).text.includes(original.text));
  assert.match(html,/id="site-header-root"/);
  assert.equal(verifyPagePatch(html,patch).passed,true);
});
