import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveAdzunaRedirect} from './adzuna-redirect.js';
import {assertExternalNavigationUrl} from './external-url.js';
const source='https://www.adzuna.com.au/jobs/land/ad/123?utm_source=fixture';
const validate=(url:string)=>assertExternalNavigationUrl(url,async host=>host!=='127.0.0.1',true);

test('tracking requests retain referral parameters and stop before the employer site',async()=>{
 const requests:string[]=[];
 const destination='https://www.seek.com.au/job/95593975?source=adzuna';
 const url=await resolveAdzunaRedirect(source,{validate,fetch:async(input,options)=>{
  requests.push(String(input));assert.equal(options?.redirect,'manual');assert.equal(options?.credentials,'omit');
  return new Response(null,{status:302,headers:{location:requests.length===1?'/jobs/land/ad/123?next=fixture':destination}});
 }});
 assert.equal(url,destination);assert.deepEqual(requests,[source,'https://www.adzuna.com.au/jobs/land/ad/123?next=fixture']);
});

test('private and invalid tracking destinations are rejected before a browser or employer request',async()=>{
 for(const destination of ['https://127.0.0.1/private','http://example.com/job','https://example.com/payment']){
  let calls=0;
  await assert.rejects(resolveAdzunaRedirect(source,{validate,fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:destination}});}}),/unavailable vacancy address/);
  assert.equal(calls,1);
 }
});

test('tracking loops and transport errors remain bounded and do not expose query strings',async()=>{
 await assert.rejects(resolveAdzunaRedirect(source,{validate,fetch:async()=>new Response(null,{status:302,headers:{location:source}})}),/repeated/);
 await assert.rejects(resolveAdzunaRedirect(source,{validate,fetch:async input=>{throw Error(String(input));}}),error=>error instanceof Error&&!error.message.includes('utm_source'));
 await assert.rejects(resolveAdzunaRedirect(source,{validate,fetch:async()=>new Response(null,{status:403})}),/HTTP 403/);
});
