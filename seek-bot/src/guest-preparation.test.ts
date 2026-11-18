import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {chromium} from 'patchright';
import {inspectGuestPreparation} from './guest-preparation.js';
import {guestPreparationContext} from './browser.js';
import type {CelerisRequest,CelerisReply} from './agent/celeris.js';
import type {Observation} from './agent/observe.js';
import type {JobListing} from './types.js';

test('real browser guest checks follow Apply, reject magic-link accounts, isolate sessions, handle optional guest and popup/iframe forms without sending',async()=>{
 let writes=0;const requests:string[]=[];
 const form='<main><h1>Analyst at Fixture</h1><h2>Apply for this job</h2><form method="POST" action="/submit"><label>Full name<input name="name"></label><label>Email address<input name="email" type="email"></label><label>Resume<input name="resume" type="file"></label><button>Submit application</button></form></main>';
 const login='<main><h1>Analyst at Fixture</h1><dialog open><h2>Sign in to apply</h2><button type="button">Continue with Google</button><form method="POST" action="/login"><label>Email address<input type="email" name="email"></label><button>Send sign-in link</button></form></dialog></main>';
 const server=createServer((req,res)=>{
  requests.push(req.url??'');if(req.method!=='GET'){writes++;res.end('Unexpected send');return;}
  res.setHeader('Content-Type','text/html');
  const path=req.url?.split('?')[0];
  if(path==='/guest')res.end(form);
  else if(path==='/listing')res.end('<main><h1>Analyst at Fixture</h1><button onclick="location.href=\'/guest\'">Apply Now</button></main>');
  else if(path==='/gated')res.end(req.headers.cookie?.includes('employer=logged-in')?form:login);
  else if(path==='/registration')res.end('<main><h1>Create an account to apply</h1><form method="POST" action="/register"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password" autocomplete="new-password"></label><button>Create an account</button></form></main>');
  else if(path==='/sign-in-only')res.end(login.replace('</main>','<a href="/registration">Create an account</a></main>'));
  else if(path==='/optional')res.end(login.replace('</main>','<a href="/guest">Continue as guest</a></main>'));
  else if(path==='/popup')res.end('<main><h1>Analyst at Fixture</h1><button onclick="window.open(\'/guest\')">Apply Now</button></main>');
  else if(path==='/iframe')res.end('<h1>Analyst at Fixture</h1><iframe src="/guest"></iframe>');
  else if(path==='/email')res.end('<main><h1>Analyst at Fixture</h1><p>Apply by email</p><a href="mailto:hiring@fixture.invalid">hiring@fixture.invalid</a></main>');
  else if(path==='/file-only')res.end('<main><h1>Analyst at Fixture</h1><h2>Attach your resume</h2><input type="file" aria-label="Resume" style="display:none"><button type="button">Upload resume</button></main>');
  else if(path==='/closed')res.end('<main>This position is no longer accepting applications.</main>');
  else if(path==='/slow')res.end('<main>Loading...</main><script>setTimeout(()=>document.querySelector(\'main\').innerHTML='+JSON.stringify(form)+',200)</script>');
  else {res.statusCode=503;res.end('<main>The employer application is temporarily unavailable.</main>');}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable'});
 const parent=await browser.newContext({storageState:{cookies:[{name:'employer',value:'logged-in',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'},
 {name:'google',value:'private',domain:'.google.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'},
 {name:'seek',value:'native-session',domain:'.seek.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]}});
 const page=await parent.newPage();const parentState=await parent.storageState();
 try{
  for(const path of ['/listing','/gated','/optional','/popup','/iframe','/email','/file-only','/closed','/slow','/unreachable','/guest','/registration','/sign-in-only']){
   let calls=0,submitAttempt=false;
   const job:JobListing={id:'fixture'+path.replaceAll('/','-'),title:'Analyst',company:'Fixture',location:'Sydney',platform:'jora',url:origin+path,description:'Fixture job'};
   const result=await inspectGuestPreparation(page,job,{
    allowRegistration:path==='/registration'||path==='/sign-in-only',
    context:async context=>{const isolated=await guestPreparationContext(context);const state=await isolated.storageState();assert.deepEqual(state.cookies.map(c=>c.name),['seek']);return isolated;},
    guard:async context=>{let blocked:string|null=null;const route:Parameters<typeof context.route>[1]=async request=>{if(new URL(request.request().url()).origin===origin)await request.continue();else{blocked='Fixture unexpected destination';await request.abort();}};await context.route('**/*',route);return {blocked:()=>blocked,stop:()=>context.unroute('**/*',route)};},
    chat:async(request:CelerisRequest):Promise<CelerisReply>=>{
     assert(++calls<12,'The checker repeated an unchanged mistake');
     assert(request.tools?.every(tool=>tool.name==='check_guest_application'));
     const last=[...request.messages].reverse().find(m=>m.role==='user')!;
     const text=typeof last.content==='string'?last.content:last.content!.find(p=>p.type==='text')! as {text:string};
     const observed=JSON.parse(typeof text==='string'?text:text.text) as Observation;
     const action=(text:string)=>observed.actions.find(action=>action.text===text);
     let args:Record<string,unknown>;
     if(path==='/guest'&&!submitAttempt){submitAttempt=true;args={action:'click',ref:action('Submit application')?.ref,reason:'Attempting a form submit must never execute in this capability.'};}
     else if(action('Apply Now'))args={action:'click',ref:action('Apply Now')!.ref,reason:'Open the actual application.'};
     else if(action('Continue as guest'))args={action:'click',ref:action('Continue as guest')!.ref,reason:'Use the optional guest path.'};
     else if(path==='/registration'||path==='/sign-in-only'&&calls===1)args={action:'registration',reason:'Create an account',
       field_refs:observed.fields.filter(field=>field.inputType==='email').map(field=>field.ref)};
     else if(observed.text.includes('Sign in to apply'))args={action:'skip',reason:'Sign in to apply: an employer account or magic-link login is required.'};
     else if(observed.fields.some(field=>field.label.includes('Full name')))args={action:'guest',reason:'Apply for this job',field_refs:observed.fields.filter(field=>field.label.includes('Full name')).map(field=>field.ref)};
     else if(action('hiring@fixture.invalid'))args={action:'guest',reason:'Apply by email',ref:action('hiring@fixture.invalid')!.ref};
     else if(observed.actions.some(a=>a.role==='file'))args={action:'guest',reason:'Attach your resume',ref:observed.actions.find(a=>a.role==='file')!.ref};
     else if(observed.text.includes('no longer accepting'))args={action:'skip',reason:'This position is no longer accepting applications.'};
     else if(observed.text.includes('Loading'))args={action:'wait',reason:'Wait for the loading application to expose its form.'};
     else args={action:'error',reason:'The employer application is temporarily unavailable.'};
     const id='call-'+calls;return {text:'',toolCalls:[{id,name:'check_guest_application',args}],message:{role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'check_guest_application',arguments:JSON.stringify(args)}}]}};
    },
   });
   const expected=!['/gated','/closed','/unreachable','/sign-in-only'].includes(path);
   assert.equal(result.ok,expected,path+': '+JSON.stringify(result));
   if(result.ok){assert.equal(result.proof.access,path==='/registration'?'registration-confirmed':'guest-confirmed');assert.equal(result.proof.isolation,'no-employer-session');}
   assert.equal(browser.contexts().length,1,'inspection context is always closed');
  }
  assert.equal(writes,0,'no login, application, email or form submit was sent');
  assert.deepEqual(await parent.storageState(),parentState,'saved employer, Google and SEEK sessions remain unchanged');
  console.log('PASS: isolated guest forms, required login/magic links, optional guest, popup, iframe, email, closed/unavailable jobs, delayed rendering, no submissions and no changes to saved sessions.');
 }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
