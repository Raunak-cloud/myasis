import assert from 'node:assert/strict';
import test from 'node:test';
import type {BrowserContext} from 'patchright';
import {assertExternalJobUrl,assertExternalNavigationUrl,guardExternalNavigations} from './external-url.js';

const publicHost=async()=>true;
const callback=`https://idp.federate.amazon.com/api/saml/redirect?SAMLResponse=${'x'.repeat(2500)}&RelayState=original-state`;

test('a signed login handoff preserves long state while pasted job links retain their limit',async()=>{
 assert.ok(callback.length>2048);
 await assert.rejects(assertExternalJobUrl(callback,publicHost),/too long/);
 assert.equal(await assertExternalNavigationUrl(callback,publicHost),callback);
 await assert.rejects(assertExternalNavigationUrl(`https://idp.federate.amazon.com/?state=${'x'.repeat(65536)}`,publicHost),/too long/);
});

test('long browser handoffs retain protocol, destination and public-address checks',async()=>{
 for(const url of [callback.replace('https:','http:'),callback.replace('idp.federate.amazon.com','localhost'),callback.replace('/api/saml/redirect','/payment'),callback.replace('idp.federate.amazon.com','www.seek.com.au')]){
  await assert.rejects(assertExternalNavigationUrl(url,publicHost));
 }
 await assert.rejects(assertExternalNavigationUrl(callback,async()=>false),/public internet addresses/);
 await assert.rejects(assertExternalNavigationUrl('https://127.0.0.1/?state='+ 'x'.repeat(2500)),/public internet addresses/);
});

test('the browser guard permits long public callback documents and still blocks private documents',async()=>{
 let handler: Parameters<BrowserContext['route']>[1]|undefined,removed=false;
 const context={route:async(_pattern:string,fn:typeof handler)=>{handler=fn;},unroute:async(_pattern:string,fn:typeof handler)=>{assert.equal(fn,handler);removed=true;}} as unknown as BrowserContext;
 const guard=await guardExternalNavigations(context);
 const visit=async(url:string,type='document')=>{
  let disposition='';
  const route={request:()=>({url:()=>url,resourceType:()=>type}),fallback:async()=>{disposition='allowed';},abort:async()=>{disposition='blocked';}};
  await (handler as Function)(route);
  return disposition;
 };
 // A numeric public address keeps this routing regression independent of DNS.
 assert.equal(await visit(callback.replace('idp.federate.amazon.com','8.8.8.8')),'allowed');
 assert.equal(guard.blocked(),null);
 assert.equal(await visit('https://127.0.0.1/?state='+ 'x'.repeat(2500)),'blocked');
 assert.match(guard.blocked()!,/public internet addresses/);
 assert.equal(await visit('https://localhost/asset.js','script'),'allowed');
 await guard.stop();assert.ok(removed);
});
