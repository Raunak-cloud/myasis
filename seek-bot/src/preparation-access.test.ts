import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser } from 'patchright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreparationAccess, preparationTransport, preparationGraphqlAllowed, preparationSurface } from './preparation-access.js';
import { withApplicationModel } from './application-model.js';
import { stagePendingCredential, acceptPendingCredential } from './site-credentials.js';
import type { CandidateProfile,JobListing } from './types.js';
import type { CelerisRequest } from './agent/celeris.js';
import type { Observation } from './agent/observe.js';

const profile={name:'Fixture Candidate',email:'candidate@fixture.invalid'} as CandidateProfile;
const job={id:'fixture',title:'Analyst',company:'Fixture employer',location:'Sydney',url:'https://employer.fixture.invalid/job'} as JobListing;
const application='<main><h1>Job application</h1><form onsubmit="event.preventDefault();window.sent=true"><label>First name<input id=name></label><label>Resume<input id=resume type=file></label><button>Submit application</button></form></main>';
const login='<main><h1>Sign in</h1><form onsubmit="event.preventDefault();if(document.querySelector(\'#email\').value&&document.querySelector(\'#password\').value)location.href=\'/application\'"><label>Email<input id=email type=email></label><label>Password<input id=password type=password></label><button>Sign in</button></form></main>';
const choose=async(r:CelerisRequest)=>{
 const user=[...r.messages].reverse().find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('{'))!;
 const data=JSON.parse(String(user.content)),o=data.observation;
 const refs=o.fields.map((f:{ref:string})=>f.ref);
 const args=refs.length && !o.fields.some((f:{type:string})=>f.type==='password')?{action:'skip',reason:'No supported login'}
  :o.fields.some((f:{type:string})=>f.type==='password') && !r.messages.some(m=>m.role==='user'&&String(m.content).includes('Private sign-in fields filled'))
   ?{action:'credentials',refs,reason:'Use the saved login'}:{action:'login',ref:o.actions.find((a:{text:string})=>/sign in/i.test(a.text))?.ref,reason:'Sign in'};
 return {text:'',toolCalls:[{id:'fixture',name:'choose_access_action',args}],message:{role:'assistant' as const,content:null}};
};
async function browser():Promise<Browser>{return chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});}

test('SEEK batched reads and the exact job-opened tracking event are allowed; mixed sends and altered trackers are rejected',()=>{
 const url='https://www.seek.com.au/graphql',read={operationName:'GetUser',query:'query GetUser { viewer { _id } }',variables:{}};
 const tracker={operationName:'TrackJobApplicationStarted',query:'mutation TrackJobApplicationStarted($input: TrackJobApplicationStartedInput!) { trackJobApplicationStarted(input: $input) { eventId __typename } }',variables:{input:{jobId:12345678,sessionId:'fixture',applicationCorrelationId:'fixture',isProfileApply:false}}};
 assert.equal(preparationGraphqlAllowed([read],url,'12345678'),true);
 assert.equal(preparationGraphqlAllowed([read,tracker],url,'12345678'),true);
 assert.equal(preparationGraphqlAllowed([read,{query:'mutation { submitApplication }'}],url,'12345678'),false);
 assert.equal(preparationGraphqlAllowed([read,tracker],url,'87654321'),false);
 assert.equal(preparationGraphqlAllowed([read,tracker],'https://employer.fixture.invalid/graphql','12345678'),false);
 assert.equal(preparationGraphqlAllowed({...tracker,query:tracker.query.replace('eventId','eventId submitApplication')},url,'12345678'),false);
 assert.equal(preparationGraphqlAllowed({...tracker,variables:{input:{...tracker.variables.input,answers:['not allowed']}}},url,'12345678'),false);
});

test('a delayed application shell is observed after hydration instead of being prematurely skipped',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<main><h1>Loading</h1></main><script>setTimeout(()=>{document.querySelector('main').outerHTML=${JSON.stringify(application)}},400)</script>`}));
 try{const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Hydration is not an AI decision');}});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(await page.locator('#name').inputValue(),'');}finally{await b.close();}
});

test('document-step upload actions prove access without uploading or advancing the wizard',()=>{
 const observation:Observation={url:'https://au.seek.com/job/12345678/apply',title:'Group Dog Walker',text:'Choose documents Answer employer questions Update SEEK Profile Review and submit',fields:[],actions:[{ref:'a1',text:'Resumé Upload (accepts .doc,application/pdf)',role:'button',disabled:false},{ref:'a2',text:'Cover letter Upload (accepts .doc,application/pdf)',role:'button',disabled:false},{ref:'a3',text:'Continue',role:'button',disabled:false}]};
 assert.equal(preparationSurface(observation), 'application');
 assert.equal(preparationSurface({...observation,text:'Job listing',actions:[{ref:'a1',text:'Avatar file input',role:'button',disabled:false}]}),'unknown');
});

test('Apply precedes optional Sign in; accessible forms remain completely unfilled',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();const visits:string[]=[];
 await ctx.route('**/*',async r=>{const path=new URL(r.request().url()).pathname;visits.push(path);await r.fulfill({contentType:'text/html',body:path==='/job'?'<main><h1>Analyst</h1><a href="/login">Sign in</a><a href="/application">Apply now</a></main>':application});});
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('No AI needed for this access check');}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(visits,['/job','/application']);
  assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 }finally{await b.close();}
});

test('required login without saved credentials is skipped without filling identity or job fields',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-prepare-auth-'));const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:login}));
 try{await withApplicationModel({DATA_DIR:dir},async()=>{
  const result=await checkPreparationAccess(page,{...job,applicationUrl:'https://employer.fixture.invalid/login'},profile,{fixture:true,chat:choose});
  assert.equal(result.ok,false);assert.equal(await page.locator('#email').inputValue(),'');assert.equal(await page.locator('#password').inputValue(),'');
 });}finally{await b.close();rmSync(dir,{recursive:true,force:true});}
});

test('accepted owner credential signs in and stops at an untouched application form',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-prepare-known-auth-'));const old=process.env.SITE_AUTH_SECRET;process.env.SITE_AUTH_SECRET='fixture-only-secret';
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/application'?application:login}));
 try{await withApplicationModel({DATA_DIR:dir},async()=>{
  const url='https://employer.fixture.invalid/login';
  const p=stagePendingCredential(url,profile.email,job.company,'create_account',{format:'readable-v1'});
  assert.equal(acceptPendingCredential(url,profile.email,job.company,'create_account',p),true);
  const result=await checkPreparationAccess(page,{...job,applicationUrl:url},profile,{fixture:true,chat:choose});
  assert.equal(result.ok,true,JSON.stringify(result));if(result.ok)assert.equal(result.access,'signed-in');
  assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 });}finally{if(old===undefined)delete process.env.SITE_AUTH_SECRET;else process.env.SITE_AUTH_SECRET=old;await b.close();rmSync(dir,{recursive:true,force:true});}
});

test('preparation transport blocks application submissions even inside the private login window',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();const sent:string[]=[];
 await ctx.route('**/*',r=>{if(r.request().method()==='POST')sent.push(new URL(r.request().url()).pathname);return r.fulfill({contentType:'text/html',body:'<main>Fixture</main>'});});
 await page.goto(job.url);const guard=await preparationTransport(page,true);
 try{
  const blocked=await page.evaluate(async()=>{try{await fetch('/submitApplication',{method:'POST',body:'{}'});return false;}catch{return true;}});
  assert.equal(blocked,true);guard.authentication(true);
  const blockedAuth=await page.evaluate(async()=>{try{await fetch('/graphql',{method:'POST',body:JSON.stringify({query:'mutation { submitApplication }'})});return false;}catch{return true;}});
  assert.equal(blockedAuth,true);assert.deepEqual(sent,[]);
 }finally{await guard.stop();await b.close();}
});
