import assert from 'node:assert/strict';
import test from 'node:test';
import type {BrowserContext} from 'patchright';
import {allowedNativeHandoffBoards,assertExternalJobUrl,assertExternalNavigationUrl,guardExternalNavigations} from './external-url.js';
import {withApplicationModel} from './application-model.js';

const publicHost=async()=>true;
const callback=`https://idp.federate.amazon.com/api/saml/redirect?SAMLResponse=${'x'.repeat(2500)}&RelayState=original-state`;

test('a signed login handoff preserves long state while pasted job links retain their limit',async()=>{
 assert.ok(callback.length>2048);
 await assert.rejects(assertExternalJobUrl(callback,publicHost),/too long/);
 assert.equal(await assertExternalNavigationUrl(callback,publicHost),callback);
 const longCallback=`https://idp.federate.amazon.com/?state=${'x'.repeat(100000)}`;
 assert.equal(await assertExternalNavigationUrl(longCallback,publicHost),longCallback,'browser redirects have no Owtomate length gate');
});

test('long browser handoffs retain protocol, destination and public-address checks',async()=>{
 for(const url of [callback.replace('https:','http:'),callback.replace('idp.federate.amazon.com','localhost'),callback.replace('/api/saml/redirect','/payment')]){
  await assert.rejects(assertExternalNavigationUrl(url,publicHost));
 }
 await assert.rejects(assertExternalNavigationUrl(callback,async()=>false),/public internet addresses/);
 await assert.rejects(assertExternalNavigationUrl('https://127.0.0.1/?state='+ 'x'.repeat(2500)),/public internet addresses/);
});

test('public board handoffs honour the native boards authorised for an application', async () => {
 const url = 'https://www.seek.com.au/job/12345678';
 assert.equal(await assertExternalNavigationUrl(url, publicHost, ['seek']), url);
 await assert.rejects(assertExternalNavigationUrl(url, publicHost, ['indeed']), /outside this run/);
 await assert.rejects(assertExternalNavigationUrl(url, publicHost, false), /outside this run/);
 const thirdParty = 'https://jobs.lever.co/fixture/123/apply';
 assert.equal(await assertExternalNavigationUrl(thirdParty, publicHost, false), thirdParty);
});

test('a targeted run uses the connected boards supplied by the dashboard, including an empty selection', t => {
 const previous = process.env.APPLY_ONLY;
 t.after(() => { if (previous === undefined) delete process.env.APPLY_ONLY; else process.env.APPLY_ONLY = previous; });
 process.env.APPLY_ONLY = 'all';
 const boards = (selection: string, guest = 'false') => withApplicationModel(
   { ALLOWED_NATIVE_HANDOFF_BOARDS: selection, FREE_EMPLOYER_GUEST_ONLY: guest }, allowedNativeHandoffBoards);
 assert.deepEqual(boards('indeed'), ['indeed']);
 assert.deepEqual(boards(''), []);
 assert.deepEqual(boards('seek,indeed', 'true'), []);
 process.env.APPLY_ONLY = 'external';
 assert.deepEqual(boards('seek,indeed'), []);
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
