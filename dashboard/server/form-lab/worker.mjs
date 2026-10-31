// Plain JavaScript is intentional: browser-side functions must not be rewritten
// by a TypeScript runtime before Playwright serializes them.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {materials,formCatalog} from './engine.mjs';
const output=process.env.FORM_LAB_OUTPUT,id=process.env.FORM_LAB_ID,key=process.env.FORM_LAB_KEY,email=process.env.FORM_LAB_EMAIL;
if(!output||!id||!formCatalog.some(form=>form.key===key))throw Error('Missing authorized form-test configuration.');
const definition=formCatalog.find(form=>form.key===key),candidate=materials(email),data=join(output,'data');
for(const dir of [data,join(data,'resumes'),join(data,'knowledge')])mkdirSync(dir,{recursive:true,mode:0o700});
Object.assign(process.env,{DATA_DIR:data,DRY_RUN:'true',ALLOW_EXTERNAL_APPLY:'true',APPLICATION_REVIEW_MODE:'',COST_TRACKING:'true',PROFILE_PATH:join(data,'profile.txt'),
 OWTOMATE_USER_ID:'form-lab-'+id,SITE_AUTH_SECRET:'isolated-'+id,APPLICATION_AGENT_MODE:'agent-only',APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN:'true',
 ADMIN_UNLIMITED:'false',AGENT_BUDGET_USD:'0.20',AGENT_PROGRESS_BUDGET_USD:'0.70',RESUME_SELECT:'synthetic-cv',FORM_CORPUS_DIR:join(data,'form-corpus'),
 KEYWORDS:'Software Engineer',WORK_ARRANGEMENTS:'hybrid,onsite,remote',ONSITE_CITY:'Sydney',COVER_LETTER_MODE:'tailored',COVER_LETTER_TEXT_B64:'',AI_INSTRUCTIONS_B64:'',
 COVER_LETTER_INSTRUCTIONS:'Use only the fictional candidate evidence; address the fictional employer.'});
writeFileSync(join(data,'profile.txt'),candidate.text);
writeFileSync(join(data,'resumes',candidate.files.cv.name),candidate.files.cv.bytes);
writeFileSync(join(data,'resumes.json'),JSON.stringify([{id:'synthetic-cv',label:'Fictional candidate CV',fileName:candidate.files.cv.name,isDefault:true}]));
const supporting=['qualification','sampleA','sampleB'];
writeFileSync(join(data,'knowledge.json'),JSON.stringify(supporting.map(file=>({id:file,label:{qualification:'Fictional qualification certificate',sampleA:'React work sample',sampleB:'SQL work sample'}[file],kind:'file',fileName:candidate.files[file].name,enabled:true,addedAt:new Date().toISOString()}))));
for(const file of supporting)writeFileSync(join(data,'knowledge',candidate.files[file].name),candidate.files[file].bytes);
writeFileSync(join(data,'answers.json'),JSON.stringify([{question:'Consent for fictional test',answer:'I consent to fictional application processing, the fictional accuracy declaration and reference check. Decline marketing.'}]));
const {chromium}=createRequire(new URL('../../../seek-bot/package.json',import.meta.url))('patchright');
const started=Date.now(),parentPid=process.ppid;let browser,context,server,result,error,stopping=false,modelCalls=0;
const writeStatus=()=>writeFileSync(join(output,'worker-status.json'),JSON.stringify({elapsedMs:Date.now()-started,modelCalls,pid:process.pid}));
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(url.pathname.endsWith('/chat/completions')){modelCalls++;writeStatus();}
 return originalFetch(input,init);
};
const stop=()=>{if(stopping)return;stopping=true;error ||= 'Test stopped by an administrator.';void browser?.close();setTimeout(()=>process.exit(130),10000).unref();};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const watchdog=setTimeout(()=>{error='The 25-minute synthetic test time limit was reached.';stopping=true;void browser?.close();},25*60_000);
watchdog.unref();
const heartbeat=setInterval(()=>{if(process.ppid!==parentPid){error='The form-test coordinator stopped.';stop();}writeStatus();},2000);heartbeat.unref();
const base='/forms/attempts/'+id,host='forms.owtomate.invalid';
try{
 // Real HTTP receives original multipart file bytes. Browser interception
 // alone can omit bytes for path-backed uploads.
 server=createServer(async(req,res)=>{
  try{
   if(!req.url?.startsWith(base+'/')||req.headers.host?.split(':')[0]!==host){res.writeHead(403);res.end();return;}
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>10_000_000)throw Error('Test request exceeds 10 MB.');chunks.push(chunk);}
   const headers={'X-Owtomate-Form-Test':process.env.FORM_LAB_TOKEN};if(req.headers['content-type'])headers['Content-Type']=req.headers['content-type'];
   const response=await originalFetch(new URL(req.url,process.env.FORM_LAB_BACKEND),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),redirect:'manual',signal:AbortSignal.timeout(30000)});
   res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([name])=>['content-type','location','cache-control','x-content-type-options','content-security-policy','referrer-policy'].includes(name))));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)res.writeHead(502,{'Content-Type':'text/plain'});res.end('The synthetic form service did not respond. Retry after inspecting the current page.');}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 if(stopping)throw Error('Test stopped before the browser started.');
 const port=server.address().port,url=`http://${host}:${port}${base}/page/1`;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable',args:['--disable-dev-shm-usage','--no-proxy-server',`--host-resolver-rules=MAP ${host} 127.0.0.1`]});
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 if(stopping)throw Error('Test stopped before the agent started.');
 await context.route('**/*',route=>new URL(route.request().url()).hostname===host&&new URL(route.request().url()).pathname.startsWith(base+'/')?route.continue():route.abort());
 await context.routeWebSocket('**/*',ws=>ws.close());
 const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
 const captures=setInterval(()=>{const current=context.pages().filter(tab=>!tab.isClosed()).at(-1);void current?.screenshot({path:join(output,'latest.png')}).catch(()=>{});},6000);captures.unref();
 try{
  const {runApplicationAgent}=await import('../../../seek-bot/dist/agent/loop.js');
  result=await runApplicationAgent({simulation:'isolated-form',page,job:{id:'form-lab-'+id,title:'Software Engineer',company:definition.company,location:'Sydney, Australia',url,source:'chosen',platform:'seek',applicationMode:'external',description:'Authorized synthetic application. Complete all 15 pages using only the supplied fictional Alex Morgan evidence. This portal is a test and sends no application to a real employer.'},profile:candidate.profile,log:line=>console.log(line)});
 }finally{clearInterval(captures);}
}catch(caught){error ||= String(caught?.message||caught);}
finally{
 clearInterval(heartbeat);clearTimeout(watchdog);globalThis.fetch=originalFetch;
 const current=context?.pages().filter(page=>!page.isClosed()).at(-1);
 const text=await current?.locator('body').innerText({timeout:2500}).catch(()=>'')||'';
 await current?.screenshot({path:join(output,'latest.png'),fullPage:true}).catch(()=>{});
 writeFileSync(join(output,'result.json'),JSON.stringify({result,error,elapsedMs:Date.now()-started,modelCalls,receiptVisible:text.includes('Application submitted successfully')&&text.includes('OWT-TEST-'),finishedAt:new Date().toISOString()}));
 writeStatus();await browser?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
 process.exit(error?1:0);
}
