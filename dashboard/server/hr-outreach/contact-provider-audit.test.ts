import assert from 'node:assert/strict';
import {test} from 'node:test';
import {auditContactProvider} from './contact-provider-audit.js';

test('Hunter comparison uses header authentication, HR filtering, actual provenance and provider verification labels',async()=>{
 const result=await auditContactProvider('hunter',{company:'Acme',domain:'https://www.acme.org/'},{key:'fixture-secret',network:async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://api.hunter.io');assert.equal(url.searchParams.get('department'),'hr');assert.equal(url.searchParams.get('domain'),'acme.org');
  assert.equal(new Headers(init?.headers).get('X-API-KEY'),'fixture-secret');assert.doesNotMatch(url.href,/fixture-secret/);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  return Response.json({data:{organization:'Acme',emails:[{value:'jane@acme.org',position:'Talent Acquisition Lead',provenance:'found',verification:{status:'accept_all',date:'2026-11-17'},sources:[{uri:'https://acme.org/people/jane'}]},{value:'j***@acme.org'}]},meta:{results:2}},{headers:{'X-Credits-Used':'1'}});
 }});
 assert.equal(result.outcome,'contacts_returned');assert.equal(result.contacts.length,1);assert.equal(result.contacts[0].verification,'accept_all');assert.equal(result.reportedCredits,1);assert.equal(result.calls,1);
});

test('Apollo search previews are not counted as emails; bounded enrichment requests only work email without extra services',async()=>{
 const paths:string[]=[];
 const result=await auditContactProvider('apollo',{company:'Acme',domain:'acme.org'},{key:'fixture',maxReveals:1,network:async(input,init)=>{
  const url=new URL(String(input));paths.push(url.pathname);assert.equal(url.hostname,'api.apollo.io');assert.equal(new Headers(init?.headers).get('X-API-KEY'),'fixture');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
  if(url.pathname.endsWith('/api_search')){assert.equal(url.searchParams.get('q_organization_domains_list[]'),'acme.org');assert.ok(url.searchParams.getAll('person_titles[]').includes('recruiter'));return Response.json({total_entries:2,people:[{id:'person-1',has_email:true},{id:'person-2',has_email:true}]});}
  assert.equal(url.searchParams.get('id'),'person-1');for(const p of ['reveal_personal_emails','reveal_phone_number','run_waterfall_email','run_waterfall_phone'])assert.equal(url.searchParams.get(p),'false');
  return Response.json({person:{name:'Jane',email:'jane@acme.org',email_status:'verified',title:'Recruiter',organization:{name:'Acme'},country:'Australia'}});
 }});
 assert.equal(result.contacts[0].email,'jane@acme.org');assert.equal(result.enrichments,1);assert.equal(result.reportedCredits,null);assert.deepEqual(paths,['/api/v1/mixed_people/api_search','/api/v1/people/match']);
 const preview=await auditContactProvider('apollo',{company:'Acme',domain:'acme.org'},{key:'fixture',maxReveals:0,network:async()=>Response.json({total_entries:1,people:[{id:'person',has_email:true}]})});assert.equal(preview.outcome,'people_without_email');assert.equal(preview.contacts.length,0);
});

test('a separate all-departments Hunter audit can measure generic inbox coverage without labelling it HR',async()=>{
 const result=await auditContactProvider('hunter',{company:'Acme',domain:'acme.org'},{key:'fixture',hunterDepartment:'all',network:async(input)=>{
  assert.equal(new URL(String(input)).searchParams.has('department'),false);
  return Response.json({data:{emails:[{value:'hello@acme.org',department:'support'}]},meta:{results:1}});
 }});
 assert.equal(result.contacts[0].department,'support');assert.equal(result.contacts[0].title,undefined);
});

test('missing access, zero results and provider errors remain distinct and never expose keys or payloads',async()=>{
 let calls=0;const network=async()=>{calls++;throw Error('PRIVATE');};
 assert.equal((await auditContactProvider('hunter',{company:'Acme'},{network})).outcome,'not_configured');assert.equal(calls,0);
 assert.equal((await auditContactProvider('apollo',{company:'Acme'},{key:'fixture',network})).outcome,'domain_required');assert.equal(calls,0);
 for(const [status,code] of [[401,'authentication_failed'],[402,'credits_or_billing'],[403,'api_access_denied'],[429,'rate_limited'],[503,'provider_http_error']] as const){
  const r=await auditContactProvider('hunter',{company:'Acme'},{key:'PRIVATE_KEY',network:async()=>Response.json({error:'PRIVATE_PAYLOAD'},{status})});assert.equal(r.error?.code,code);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
 }
 const empty=await auditContactProvider('hunter',{company:'Acme'},{key:'fixture',network:async()=>Response.json({data:{emails:[]},meta:{results:0}})});assert.equal(empty.outcome,'no_results');
 const malformed=await auditContactProvider('apollo',{company:'Acme',domain:'acme.org'},{key:'fixture',network:async()=>Response.json({message:'PRIVATE'})});assert.equal(malformed.outcome,'error');assert.doesNotMatch(JSON.stringify(malformed),/PRIVATE/);
});
