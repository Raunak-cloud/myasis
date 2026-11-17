import assert from 'node:assert/strict';
import {test} from 'node:test';
import {researchPageView} from './research-page.js';
import {PublicSourceResponseError,publicResearchFailure} from './research-failure.js';

test('long public pages expose later text and footer links without inventing or guessing contacts',()=>{
  const text='<html><head><title>Example</title></head><body>'+Array.from({length:130},(_,i)=>`<a href="/products/${i}">Product ${i}</a>`).join('')+'<p>'+('Public content '.repeat(1200))+'</p><footer><p>For recruitment enquiries email talent@example.org</p><a href="mailto:talent@example.org">Email hiring team</a><a href="/careers">Careers</a></footer><script>PRIVATE_SCRIPT</script><p hidden>PRIVATE_HIDDEN</p></body></html>';
  const page={url:'https://employer.org/',status:200,type:'text/html',text,retryAfter:null};
  const first=researchPageView(page);assert.ok('text' in first);assert.equal(first.links.length,100);assert.equal(first.nextLinkOffset,100);assert.ok(first.nextOffset);
  assert.doesNotMatch(first.text??'',/talent@example.org|PRIVATE_/);
  const footer=researchPageView(page,{offset:first.nextOffset!,linkOffset:first.nextLinkOffset!});
  assert.ok('text' in footer);
  assert.match(footer.text??'',/talent@example.org/);assert.ok(footer.links.some(link=>link.url==='mailto:talent@example.org'));
  assert.ok(footer.links.some(link=>link.url==='https://employer.org/careers'));
  const found=researchPageView(page,{query:'recruitment'});assert.ok('matches' in found);assert.match(found.matches?.[0].text??'',/talent@example.org/);
  assert.doesNotMatch(JSON.stringify(found),/PRIVATE_/);
});

test('plain text contacts and HTML fragments remain readable',()=>{
  for(const type of ['text/html','text/plain']){
    const result=researchPageView({url:'https://employer.org/careers',status:200,type,text:'Recruitment: talent@employer.org',retryAfter:null});
    assert.ok('text' in result);
    assert.match(result.text??'',/talent@employer.org/);
  }
});

test('HTTP failures identify missing pages rather than claiming CAPTCHA or exposing response payloads',()=>{
  assert.equal(publicResearchFailure(new PublicSourceResponseError(404,'text/html')).code,'http_not_found');
  assert.match(publicResearchFailure(new PublicSourceResponseError(404,'text/html')).detail,/404/);
  assert.equal(publicResearchFailure(new PublicSourceResponseError(200,'application/pdf')).code,'unsupported_source_type');
  const response=new PublicSourceResponseError(503,'text/html; secret=PRIVATE');assert.doesNotMatch(JSON.stringify(response),/PRIVATE/);
});
