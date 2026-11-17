import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createRequestLimiter,requestLimitPolicy} from './request-limits.js';

const request=(route:string,userId:string|null='owner-a',method='GET',address='192.0.2.1')=>({route,userId,method,address});
test('dashboard reads do not spend login, checkout, upload or AI allowances',()=>{
 const check=createRequestLimiter();
 for(let i=0;i<100;i++)for(const route of ['/api/auth/me','/api/billing/status','/api/admin/users'])assert.equal(check(requestLimitPolicy(request(route))),null);
 for(const [route,method] of [['/api/auth/google','GET'],['/api/billing/checkout','POST'],['/api/resumes','POST'],['/api/search-terms/generate','POST']])assert.equal(check(requestLimitPolicy(request(route,'owner-a',method))),null);
 assert.equal(requestLimitPolicy(request('/api/resumes'))?.category,'dashboard-reads');
 assert.equal(requestLimitPolicy(request('/api/visitors'))?.category,'dashboard-reads');
 assert.equal(requestLimitPolicy(request('/assets/app.js')),null);
});
test('validated accounts on one address are isolated; login abuse remains address-bound',()=>{
 const check=createRequestLimiter();
 for(let i=0;i<30;i++)assert.equal(check(requestLimitPolicy(request('/api/billing/checkout','owner-a','POST'))),null);
 assert(check(requestLimitPolicy(request('/api/billing/checkout','owner-a','POST'))));
 assert.equal(check(requestLimitPolicy(request('/api/billing/checkout','owner-b','POST'))),null);
 for(let i=0;i<30;i++)assert.equal(check(requestLimitPolicy(request('/api/auth/google','owner-'+i))),null);
 assert(check(requestLimitPolicy(request('/api/auth/callback/google','another-owner'))));
 assert.equal(check(requestLimitPolicy(request('/api/auth/google',null,'GET','192.0.2.2'))),null);
});
test('read caps remain bounded, Retry-After counts down, and expired windows recover',()=>{
 let now=0;const check=createRequestLimiter(()=>now),policy=requestLimitPolicy(request('/api/billing/status'))!;
 for(let i=0;i<1200;i++)assert.equal(check(policy),null);
 now=15_200;assert.deepEqual(check(policy),{retryAfterSeconds:45,firstBlocked:true});
 now=59_500;assert.deepEqual(check(policy),{retryAfterSeconds:1,firstBlocked:false});
 now=60_000;assert.equal(check(policy),null);
 const anonymous=requestLimitPolicy(request('/api/auth/me',null))!;
 assert.equal(anonymous.limit,600);assert.match(anonymous.key,/ip:192\.0\.2\.1$/);
 const hook=requestLimitPolicy(request('/api/billing/webhook',null,'POST'))!;
 assert.notEqual(hook.key,requestLimitPolicy(request('/api/billing/checkout',null,'POST'))!.key);
});

test('actual API middleware verifies identities, reuses authentication and separates reads from actions',async()=>{
 const source=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  const handle = async'),source.indexOf('  // Connect does not await middleware promises.')).replaceAll('import.meta.dirname',JSON.stringify('/fixture'));
 const compiled=ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText;
 let time=0,authCalls=0,checkoutCalls=0;
 const deps={limitRequest:createRequestLimiter(()=>time),requestLimitPolicy,
  currentUser:async(cookie:string)=>{authCalls++;return cookie==='myasis_session=valid-a'?{id:'owner-a',email:'a@fixture.invalid'}:cookie==='myasis_session=valid-b'?{id:'owner-b',email:'b@fixture.invalid'}:null;},
  hasSessionCookie:(req:any)=>/myasis_session=/.test(req.headers.cookie??''),requesterAddress:(req:any)=>req.socket.remoteAddress,
  handleFormsRequest:async()=>false,allowedOrigin:()=>null,crossSite:(req:any)=>req.headers['sec-fetch-site']==='cross-site',DEFAULT_BODY_LIMIT:262144,UPLOAD_BODY_LIMIT:12582912,
  readJsonBody:async()=>({planKey:'essential-pass'}),billingStatus:async(userId:string)=>({owner:userId,totalRemaining:5}),
  googleConfigured:()=>true,isPaidPlanKey:()=>true,createCheckout:async()=>{checkoutCalls++;return {url:'https://fixture.invalid/checkout'};},
  BillingPolicyError:class extends Error {},console:{warn:()=>{}},
 };
 const handle=new Function(...Object.keys(deps),compiled+'\nreturn handle;')(...Object.values(deps));
 async function call(route:string,cookie='myasis_session=valid-a',method='GET',cross=false){
  const result={statusCode:200,headers:{} as Record<string,string>,body:''};
  const res={setHeader:(k:string,v:string)=>result.headers[k]=v,end:(s:string)=>result.body=s,set statusCode(n:number){result.statusCode=n;}};
  await handle({url:route,method,headers:{cookie,...(cross?{'sec-fetch-site':'cross-site'}:{})},socket:{remoteAddress:'192.0.2.10'}},res,()=>assert.fail('Unexpected fallthrough'));
  return {...result,json:JSON.parse(result.body||'{}')};
 }
 for(let i=0;i<100;i++)assert.equal((await call('/api/billing/status')).statusCode,200);
 const before=authCalls;assert.equal((await call('/api/billing/status')).statusCode,200);assert.equal(authCalls-before,1,'one validated session lookup per request');
 for(let i=0;i<30;i++)assert.equal((await call('/api/billing/checkout','myasis_session=valid-a','POST')).statusCode,200);
 time=123_000;const blocked=await call('/api/billing/checkout','myasis_session=valid-a','POST');
 assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['Retry-After'],'477');assert.equal(blocked.json.retryAfterSeconds,477);assert.equal(checkoutCalls,30);
 assert.equal((await call('/api/billing/status')).statusCode,200,'a blocked checkout never blocks its status read');
 assert.equal((await call('/api/billing/checkout','myasis_session=valid-b','POST')).statusCode,200);
 assert.equal((await call('/api/billing/status','myasis_session=owner-a')).statusCode,401,'an unvalidated cookie cannot select an account bucket or view its data');
 assert.equal((await call('/api/billing/checkout','myasis_session=valid-b','POST',true)).statusCode,403);
 assert.equal(checkoutCalls,31,'cross-site and limited requests perform no action');
 time=600_000;assert.equal((await call('/api/billing/checkout','myasis_session=valid-a','POST')).statusCode,200);
});
