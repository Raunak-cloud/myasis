import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readVerifiedHrPage} from './verification-browser.js';
import {crawlUrl,CrawlBlocked} from '../job-index/network.js';
const{chromium}=createRequire(import.meta.url)('../../../seek-bot/node_modules/patchright') as typeof import('../../../seek-bot/node_modules/patchright/index.js');
const executable=process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome-stable');
const url='https://public.org/careers';
async function fixture(html:string){
 const stats={requests:[] as string[],closed:false,cookies:0};
 const launch=(async(options:any)=>{
  const browser=await chromium.launch({...options,executablePath:executable});browser.on('disconnected',()=>{stats.closed=true;});
  const create=browser.newContext.bind(browser);browser.newContext=async(options:any)=>{const context=await create(options);stats.cookies=(await context.cookies()).length;await context.route('**/*',route=>{stats.requests.push(`${route.request().method()} ${route.request().url()}`);return route.fulfill({contentType:'text/html',body:html});});return context;};return browser;
 }) as typeof chromium.launch;
 return{stats,launch,validate:async(raw:string)=>{crawlUrl(raw);if(new URL(raw).hostname!=='public.org')throw Error('Private or unexpected fixture host');},authorize:async()=>{}};
}
const challenge='<title>Website verification</title><div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAAAAAAA" data-callback="verificationDone" style="width:280px;height:80px">Please complete the CAPTCHA.</div><input name="cf-turnstile-response"><script>window.verificationDone=token=>{if(token==="fixture-solved-token")document.body.innerHTML="<h1>Employer careers</h1><p>Recruitment careers@public.org</p>";};</script>';
test('real Chromium uses the existing CapMonster adapter against a local API fixture and reads the cleared page',{skip:!existsSync(executable),timeout:45000},async()=>{
 const keys=['CAPTCHA_SOLVER','CAPMONSTER_API_KEY','CAPMONSTER_API_URL','COST_TRACKING'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const tasks:any[]=[];
 const server=createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{const data=JSON.parse(body);if(req.url==='/createTask')tasks.push(data.task);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/createTask'?{errorId:0,taskId:71001}:{errorId:0,status:'ready',solution:{token:'fixture-solved-token'},cost:.0005}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{process.env.CAPTCHA_SOLVER='capmonster';process.env.CAPMONSTER_API_KEY='fixture-only';process.env.CAPMONSTER_API_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;process.env.COST_TRACKING='false';
  const f=await fixture(challenge);const result=await readVerifiedHrPage(url,f);assert.match(result.text,/Recruitment careers@public.org/);assert.equal(tasks.length,1);assert.equal(tasks[0].type,'TurnstileTask');assert.equal(tasks[0].websiteURL,url);assert.equal(f.stats.cookies,0);assert.ok(f.stats.closed);
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('a reported solver success is insufficient when the challenge remains',{skip:!existsSync(executable),timeout:25000},async()=>{
 const f=await fixture(challenge);await assert.rejects(readVerifiedHrPage(url,{...f,solve:async()=> 'solved',timeoutMs:16000}),/verification|respond/i);assert.ok(f.stats.closed);
});
test('self-clearing verification never purchases a solution',{skip:!existsSync(executable),timeout:15000},async()=>{
 const f=await fixture(challenge+'<script>setTimeout(()=>verificationDone("fixture-solved-token"),500);</script>');let purchases=0;
 const result=await readVerifiedHrPage(url,{...f,solve:async()=>{purchases++;return 'solved';}});assert.match(result.text,/Recruitment/);assert.equal(purchases,0);assert.ok(f.stats.closed);
});

test('inline challenge can self-clear and an unsupported JSON challenge never becomes contact evidence',{skip:!existsSync(executable),timeout:20000},async()=>{
 const bootstrap='<title>Just a moment...</title><script>window._cf_chl_opt={};const path="/cdn-cgi/challenge-platform/h/g/";</script>';
 let purchases=0;
 const f=await fixture(bootstrap+'<script>setTimeout(()=>{document.title="Careers";document.body.innerHTML="<h1>Recruitment</h1><p>careers@public.org</p>"},500);</script>');
 const result=await readVerifiedHrPage(url,{...f,solve:async()=>{purchases++;return "solved";}});assert.match(result.text,/careers@public.org/);assert.equal(purchases,0);assert.ok(f.stats.closed);
 const blocked=await fixture('<pre>'+JSON.stringify({appId:'PXfixture',jsClientSrc:'/fixture/init.js',blockScript:'/fixture/captcha.js'})+'</pre>');
 await assert.rejects(readVerifiedHrPage(url,{...blocked,solve:async()=>{purchases++;return 'solved';}}),/not supported/);assert.equal(purchases,0);assert.ok(blocked.stats.closed);
});
test('public browser blocks form posts and private hosts and closes after reading',{skip:!existsSync(executable),timeout:15000},async()=>{
 const f=await fixture('<h1>Employer careers</h1><p>Recruitment</p><script>fetch("https://127.0.0.1/private").catch(()=>{});fetch("/submit",{method:"POST",body:"x"}).catch(()=>{});</script>');
 await readVerifiedHrPage(url,f);assert.deepEqual(f.stats.requests,[`GET ${url}`]);assert.ok(f.stats.closed);
});
test('navigation still checks the redirected page permission and external cancellation closes the browser',{skip:!existsSync(executable),timeout:20000},async()=>{
 const f=await fixture('<script>location.href="/private-careers";</script>');await assert.rejects(readVerifiedHrPage(url,{...f,authorize:async()=>{throw new CrawlBlocked('Robots policy excludes this address.');},timeoutMs:5000}));assert.ok(f.stats.closed);
 const second=await fixture(challenge),controller=new AbortController();const timer=setTimeout(()=>controller.abort(Error('Cancelled fixture')),1500);
 try{await assert.rejects(readVerifiedHrPage(url,{...second,signal:controller.signal,solve:async()=> 'blocked'}),/Cancelled fixture/);assert.ok(second.stats.closed);}finally{clearTimeout(timer);}
});
