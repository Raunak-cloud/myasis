import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHiringContactSearch} from './discovery.js';
import {hrSearchConfiguration} from './search.js';
import {PublicSearchPayloadError,PublicSearchResponseError,publicResearchFailure} from './research-failure.js';

test('Serper uses its own authenticated POST and normalizes actual public Google results',async()=>{
 let reservations=0,requests=0;
 const search=createHiringContactSearch({provider:'serper',key:'fixture-secret',reserveSearch:async()=>{reservations++;return true;},network:async(input,init)=>{
  requests++;assert.equal(String(input),'https://google.serper.dev/search');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
  assert.equal(new Headers(init?.headers).get('X-API-KEY'),'fixture-secret');assert.equal(new Headers(init?.headers).get('X-Subscription-Token'),null);
  assert.deepEqual(JSON.parse(String(init?.body)),{q:'Acme Australia recruitment contact',gl:'au',hl:'en',num:6});assert.doesNotMatch(String(input)+String(init?.body),/fixture-secret/);
  return Response.json({organic:[{title:'Acme Careers',link:'https://acme.org/careers',snippet:'Contact our hiring team.'},{link:'https://127.0.0.1/private'},{link:'https://acme.org/login'},{link:'javascript:alert(1)'},{link:'https://u:pass@acme.org/'}]});
 }});
 assert.deepEqual(await search('Acme Australia recruitment contact'),[{url:'https://acme.org/careers',title:'Acme Careers',description:'Contact our hiring team.'}]);assert.equal(reservations,1);assert.equal(requests,1);
});

test('provider selection prefers configured Serper and respects explicit choices without switching billed services',()=>{
 assert.deepEqual(hrSearchConfiguration({SERPER_API_KEY:' serper ',BRAVE_SEARCH_API_KEY:'brave'}),{provider:'serper',key:'serper'});
 assert.deepEqual(hrSearchConfiguration({HR_SEARCH_PROVIDER:'brave',SERPER_API_KEY:'serper'},'fallback'),{provider:'brave',key:'fallback'});
 assert.deepEqual(hrSearchConfiguration({BRAVE_SEARCH_API_KEY:' '},'fallback'),{provider:'brave',key:'fallback'});
 assert.equal(hrSearchConfiguration({HR_SEARCH_PROVIDER:'serper',BRAVE_SEARCH_API_KEY:'brave'}),undefined);
 assert.equal(hrSearchConfiguration({HR_SEARCH_PROVIDER:'brave',SERPER_API_KEY:'serper'}),undefined);
 assert.equal(hrSearchConfiguration({}),undefined);assert.throws(()=>hrSearchConfiguration({HR_SEARCH_PROVIDER:'other'}),/Choose auto/);
});

test('Serper failures retain safe status, request accounting and cancellation without exposing payloads',async()=>{
 for(const status of [400,401,402,403,422,429,503]){
  let calls=0;
  const search=createHiringContactSearch({provider:'serper',key:'fixture-secret',reserveSearch:async()=>true,network:async()=>{calls++;return Response.json({message:'PRIVATE_PROVIDER_PAYLOAD'},{status});}});
  await assert.rejects(search('Acme'),(error:unknown)=>error instanceof PublicSearchResponseError&&error.status===status&&!String(error).includes('PRIVATE_PROVIDER_PAYLOAD'));assert.equal(calls,1);
 }
 let requests=0;
 const deferred=createHiringContactSearch({provider:'serper',key:'fixture',reserveSearch:async()=>false,network:async()=>{requests++;throw Error('Must not request');}});
 await assert.rejects(deferred('Acme'),/deferred/);assert.equal(requests,0);
 const cancelled=createHiringContactSearch({provider:'serper',key:'fixture',reserveSearch:async()=>true,network:async(_url,init)=>{init?.signal?.throwIfAborted();return Response.json({organic:[]});}});
 await assert.rejects(cancelled('Acme',AbortSignal.abort()));
 const malformed=createHiringContactSearch({provider:'serper',key:'fixture',reserveSearch:async()=>true,network:async()=>Response.json({message:'PRIVATE_PAYLOAD'})});
 await assert.rejects(malformed('Acme'),PublicSearchPayloadError);
});

test('search request rejection, account access and provider outage are reported separately',()=>{
 for(const status of [400,422])assert.equal(publicResearchFailure(new PublicSearchResponseError(status)).code,'search_request_rejected');
 for(const status of [401,403])assert.equal(publicResearchFailure(new PublicSearchResponseError(status)).code,'search_access_denied');
 assert.equal(publicResearchFailure(new PublicSearchResponseError(503)).code,'search_service_unavailable');
 assert.doesNotMatch(publicResearchFailure(new PublicSearchResponseError(400)).detail,/temporarily unavailable|no contacts/);
});

test('provider plan restrictions give actionable query feedback without exposing provider payloads',async()=>{
 const search=createHiringContactSearch({provider:'serper',key:'PRIVATE_KEY',reserveSearch:async()=>true,network:async()=>Response.json({message:'Query pattern not allowed for free accounts.',debug:'PRIVATE_KEY PRIVATE_PAYLOAD'},{status:400})});
 await assert.rejects(search('Example recruitment contact'),(error:unknown)=>{
  const report=publicResearchFailure(error);assert.equal(report.code,'search_query_restricted');assert.match(report.detail,/allowed plain-language query/);assert.doesNotMatch(JSON.stringify(error)+JSON.stringify(report),/PRIVATE_/);return true;
 });
});
