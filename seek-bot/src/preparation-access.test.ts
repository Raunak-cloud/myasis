import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser } from 'patchright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPreparationAccess, preparationSurface } from './preparation-access.js';
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

test('normal POST and GraphQL portal handoffs run without preparation request interception; employer form stays untouched',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage(),posts:string[]=[];
 const handoff={operationName:'createApplyLinkout',query:'mutation createApplyLinkout($jobId: ID!) { createLinkoutApplication(input: { jobId: $jobId }) { applicationUrl linkoutApplicationCorrelationId __typename } }',variables:{jobId:'12345678'}};
 const destination='https://employer.fixture.invalid/application';
 await ctx.route('**/*',r=>{
  const u=new URL(r.request().url());
  if(r.request().method()==='POST')posts.push(u.pathname);
  if(u.pathname==='/graphql'){assert.deepEqual(r.request().postDataJSON(),handoff);return r.fulfill({json:{data:{createLinkoutApplication:{applicationUrl:destination}}}});}
  if(u.pathname==='/navigation-session')return r.fulfill({json:{ok:true}});
  if(u.hostname==='employer.fixture.invalid')return r.fulfill({contentType:'text/html',body:application});
  return r.fulfill({contentType:'text/html',body:u.pathname.endsWith('/apply')?`<main><h1>Opening employer application</h1></main><script>fetch('/navigation-session',{method:'POST',body:'navigation'}).then(()=>fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(handoff)})})).then(r=>r.json()).then(r=>location.href=r.data.createLinkoutApplication.applicationUrl)</script>`:'<main><h1>Analyst</h1><a href="/job/12345678/apply">Apply now</a></main>'});
 });
 // Fixture routes supply pages; production preparation must add no routing layer.
 const contextRoute=ctx.route,pageRoute=page.route;
 ctx.route=async()=>{throw Error('Preparation must not intercept context requests');};
 page.route=async()=>{throw Error('Preparation must not intercept page requests');};
 try{
  const result=await checkPreparationAccess(page,{...job,id:'12345678',url:'https://au.seek.com/job/12345678'},profile,{fixture:true,chat:async()=>{throw Error('Observed access needs no model');}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(page.url(),destination);
  assert.deepEqual(posts,['/navigation-session','/graphql']);
  assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 }finally{ctx.route=contextRoute;page.route=pageRoute;await b.close();}
});

test('preparation rejects a final-send tool decision without clicking Submit',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main><h1>Review</h1><button onclick="window.sent=true">Send now</button></main>'}));
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>({text:'',toolCalls:[{id:'fixture',name:'choose_access_action',args:{action:'submit',reason:'Attempt unsupported send'}}],message:{role:'assistant',content:null}})});
  assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 }finally{await b.close();}
});

test('a native Apply form button cannot be used as a one-click submit during preparation',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main><h1>Analyst</h1><form onsubmit="event.preventDefault();window.sent=true"><button>Apply now</button></form></main>'}));
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Observed Apply is checked natively');}});
  assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 }finally{await b.close();}
});

test('navigation links and explicit non-submit Apply buttons inside a layout form remain usable',async()=>{
 for(const control of ['<a href="/application">Apply now</a>','<button type="button" onclick="location.href=\'/application\'">Apply now</button>']){
  const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
  await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/job'?`<main><h1>Analyst</h1><form onsubmit="event.preventDefault();window.sent=true">${control}</form></main>`:application}));
  try{const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Unique native navigation needs no model');}});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');}finally{await b.close();}
 }
});

test('Apply can open an employer form in a new tab without changing application fields',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();let extra:any;
 ctx.on('page',p=>{if(p!==page)extra=p;});
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/job'?'<main><h1>Analyst</h1><a href="/application" target="_blank">Apply now</a></main>':application}));
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Observed application needs no model');}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.ok(extra?.isClosed(),'Only the access-check popup is cleaned up');assert.equal(ctx.pages().length,1);
 }finally{await b.close();}
});

test('a unique employer Apply button is followed after the initial board Apply without a model guess',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();const visits:string[]=[];
 await ctx.route('**/*',r=>{const path=new URL(r.request().url()).pathname;visits.push(path);return r.fulfill({contentType:'text/html',body:path==='/job'?'<main><h1>Analyst</h1><a href="/employer-job">Apply now</a></main>':path==='/employer-job'?'<main><h1>Analyst at employer</h1><a href="/application">Apply now</a></main>':application});});
 try{const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Unique navigation must not need a model guess');}});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(visits,['/job','/employer-job','/application']);assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');}finally{await b.close();}
});

test('an observed guest application route opens the form before optional employer sign-in',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage(),visits:string[]=[];
 await ctx.route('**/*',r=>{const path=new URL(r.request().url()).pathname;visits.push(path);return r.fulfill({contentType:'text/html',body:path==='/job'?'<main><h1>Analyst</h1><a href="/access">Apply now</a></main>':path==='/access'?'<main><h1>Choose how to apply</h1><a href="/application">Apply without an account</a><a href="/login">Sign in</a><a href="/register">Create one now.</a></main>':application});});
 try{const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Observed guest route needs no model or credentials');}});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(visits,['/job','/access','/application']);assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);}finally{await b.close();}
});

test('an invalid current button reference gets fresh observation and bounded feedback instead of discarding the job',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();let calls=0;
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/job'?'<main><h1>Analyst</h1><a href="/application">Apply now</a><a href="/application">Apply now</a></main>':application}));
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async request=>{
   const user=[...request.messages].reverse().find(m=>m.role==='user'&&String(m.content).startsWith('{'))!;
   const o=JSON.parse(String(user.content)).observation;calls++;
   return {text:'',toolCalls:[{id:'fixture',name:'choose_access_action',args:{action:'apply',ref:calls===1?'expired-reference':o.actions.find((a:{text:string})=>/apply now/i.test(a.text)).ref,reason:'Open the observed matched application'}}],message:{role:'assistant',content:null}};
  }});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls,2);assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#resume').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
 }finally{await b.close();}
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

test('candidate fields and CV upload prove employer access when long listing text hides the form summary',async()=>{
 const b=await browser(),ctx=await b.newContext(),page=await ctx.newPage();
 await ctx.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<main><h1>Warehouse assistant</h1><p>${'Warehouse responsibilities. '.repeat(1100)}</p><form onsubmit="event.preventDefault();window.sent=true"><label>First name<input id=first></label><label>Last name<input id=last></label><label for=cv>Upload CV</label><input id=cv type=file><button>Apply for this position</button></form></main>`}));
 try{
  const result=await checkPreparationAccess(page,job,profile,{fixture:true,chat:async()=>{throw Error('Observed candidate and document controls prove access');}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(await page.locator('#first').inputValue(),'');assert.equal(await page.locator('#last').inputValue(),'');assert.equal(await page.locator('#cv').inputValue(),'');assert.equal(await page.evaluate(()=>Boolean((window as any).sent)),false);
  const observed=await (await import('./agent/observe.js')).observe(page);
  assert.equal(preparationSurface({...observed,fields:observed.fields.filter(f=>/first name/i.test(f.label))}),'unknown','A generic document control and one field are insufficient without application copy');
  assert.equal(preparationSurface({...observed,fields:[],actions:[{ref:'cookie',text:'Cookie settings',role:'button',disabled:false}]}),'unknown');
 }finally{await b.close();}
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
