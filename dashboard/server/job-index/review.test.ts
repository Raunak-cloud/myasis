import assert from 'node:assert/strict';
import {test} from 'node:test';
import {confirmedMatch,minimaxReviewer,REVIEW_MODEL} from './review.js';
import {normaliseJob,matchJob} from './extract.js';
import {discoveryQueries} from './discovery.js';
import type {JobIndexStore} from './store.js';
import {CrawlDeferred} from './network.js';
import {professionalEvidence} from './accounts.js';
const p={userId:'1',fingerprint:'one',keywords:['Data engineer'],skills:['Python','SQL'],location:'Sydney',arrangements:['remote'],excludedCompanies:[],sources:{}};
const e={resume:'Data engineer with Python and SQL experience.',instructions:'No senior roles.'};
const j=normaliseJob({title:'Data engineer',hiringOrganization:{name:'Fixture'},description:'Build reliable data pipelines using Python and SQL. Fully remote role.'},'https://careers.fixture.org/jobs/1')!;
const d={decision:'match' as const,score:90,reason:'Relevant work.',employerEvidence:'Build reliable data pipelines',candidateEvidence:'Python and SQL experience',constraints:'satisfied' as const};
test('admission requires a valid score, satisfied constraints and independently grounded evidence',()=>{
  assert.equal(confirmedMatch(d,j,p,e,matchJob(j,p)!)?.status,'matched');
  for(const change of [{decision:'uncertain'},{constraints:'unknown'},{score:20}])assert.equal(confirmedMatch({...d,...change},j,p,e,matchJob(j,p)!),null);
  for(const change of [{score:NaN},{candidateEvidence:'Invented security clearance'},{employerEvidence:'Invented employer requirement'}])assert.throws(()=>confirmedMatch({...d,...change},j,p,e,matchJob(j,p)!));
});
test('discovery rotates ATS hosts and combines derived resume skills without leaking owner identity',()=>{
  const first=discoveryQueries([p],'2026-11-05'),next=discoveryQueries([p],'2026-11-06');assert.notDeepEqual(first,next);assert.ok(first.some(q=>/Python|SQL/.test(q)));assert.ok(first.some(q=>q.includes('site:')));assert.doesNotMatch(JSON.stringify(first),/userId|fingerprint/);
});
test('contact redaction preserves employment date ranges and professional evidence',()=>{
  const redacted=professionalEvidence('Data engineer 2019 - 2024. Call +61 412 345 678 or 0412345678. person@example.org');
  assert.match(redacted,/2019 - 2024/);assert.doesNotMatch(redacted,/412 345 678|0412345678|person@example/);
});
test('classifier uses one bounded selected model, records charges, and cannot accept truncated output',async()=>{
  let calls=0,recorded=0;
  const store={reserveReview:async(amount:number)=>{assert.ok(amount>0&&amount<1);return 'fixture';},completeReview:async(_id:string,cost:number,basis:string)=>{assert.equal(cost,0.001);assert.equal(basis,'provider');recorded++;}} as unknown as JobIndexStore;
  const read:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.model,REVIEW_MODEL);assert.equal(body.reasoning.effort,'low');assert.equal(body.response_format.json_schema.strict,true);assert.doesNotMatch(JSON.stringify(body),/authorization|fictional-key/);assert.ok(body.messages[0].content.includes('untrusted data'));return Response.json({usage:{cost:0.001},choices:[{finish_reason:calls===1?'stop':'length',message:{content:JSON.stringify(d)}}]});};
  const review=minimaxReviewer(store,'fictional-key',read);assert.equal((await review(j,p,e)).decision,'match');await assert.rejects(()=>review(j,p,e),CrawlDeferred);assert.equal(calls,2);assert.equal(recorded,2);
  await assert.rejects(()=>minimaxReviewer(store,'',read)(j,p,e),CrawlDeferred);assert.equal(calls,2);
});
