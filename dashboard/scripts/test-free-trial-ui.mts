/** Real Apply UI; fictional accounts/APIs only. No live sign-in or application. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {RUN_SETTING_DEFAULTS} from '../server/settings.js';
const {chromium}=createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><main class="main-shell run-dashboard"><header class="page-header"><h1>Apply for jobs</h1></header><div id="root" class="page-content"></div></main><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{RunPanel}from'/src/components/RunPanel.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(RunPanel,{lastRunAt:null,onFinished:()=>{},onGoPricing:()=>{}}));</script></body></html>`;
let rewarded=false,remaining=5,legacy=false,incomplete=false;const writes:Array<{path:string;body:any}>=[];
const settings=()=>({...RUN_SETTING_DEFAULTS,KEYWORDS:'Software Engineer',PLATFORMS:legacy?'seek':'smartrecruiters,greenhouse'+(rewarded?',seek':''),WORK_ARRANGEMENTS:'remote,hybrid',ONSITE_CITY:'Sydney',MIN_SALARY:'80000'});
const entitlement=()=>({tier:'standard',manualRuns:true,firstRunRequired:true,autoRunsPerDay:1,canPauseAutoApply:true,autoApplyPaused:true,fineTune:false,advancedFilters:false,runScopes:false,indeedApplications:false,employerSources:!legacy&&remaining>0,employerTrial:!legacy,employerGuestOnly:!legacy,joraSignIn:false,seekTrialConnected:rewarded,evaluationsPerRun:30,maxApplicationsPerDay:100});
const vite=await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),plugins:[react(),{name:'free-trial-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url?.split('?')[0]==='/fixture'){res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml('/fixture',html));return;}if(!req.url?.startsWith('/api/'))return next();
 const path=new URL(req.url,'http://fixture.invalid').pathname;res.setHeader('content-type','application/json');let value:any=[];
 if(req.method==='POST'){let text='';for await(const part of req)text+=part;writes.push({path,body:JSON.parse(text||'{}')});}
 if(path==='/api/entitlements')value=entitlement();
 if(path==='/api/settings')value=req.method==='POST'?{ok:true,settings:settings()}:settings();
 if(path==='/api/billing/status')value={configured:false,free:{allowance:rewarded?11:5,used:(rewarded?11:5)-remaining,remaining,...(!legacy?{trial:{employerSites:true,seekBonusApplications:6,seekBonusAwarded:rewarded}}:{})},paid:{remaining:0,employerSiteRemaining:0,hasActivePass:false,hasActiveIntensivePass:false,hasActiveJobSearchPass:false},totalRemaining:remaining};
 if(path==='/api/setup/status')value={checks:['resume','profile','looking','boards'].map(id=>({id,label:id,fix:id==='resume'?'documents':id==='profile'?'details':id,done:id==='profile'&&incomplete?false:id!=='boards'||!legacy||rewarded,required:true,hint:''})),ready:!incomplete&&(!legacy||rewarded),done:!incomplete&&(!legacy||rewarded)?4:3,total:4};
 if(path==='/api/auto-schedule')value={enabled:false,applicationMode:'auto',runsUsedToday:0,runsPerDay:1,nextRunAt:null,dueNow:false,timeZone:'Australia/Sydney',lastError:null,waitingForSetup:false,waitingForBoard:legacy&&!rewarded,waitingForFirstRun:false};
 if(path==='/api/run/status')value={running:false,hasKey:true,isOwner:true,applied:0,prepared:0};
 if(path==='/api/signin/session'){if(req.method==='POST'){res.statusCode=503;value={error:'Fixture sign-in only. No external browser opened.'};}else value={supported:true,session:null,seek:rewarded?{signedIn:true,source:'run',account:'candidate@fixture.invalid'}:null,indeed:null,checking:false};}
 if(path==='/api/auto-apply')value={ok:true,entitlements:entitlement()};
 if(path==='/api/gmail/access')value={connected:false,configured:false,provider:'browser',admin:false,providers:[]};
 res.end(JSON.stringify(value));
 });}}],optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0},logLevel:'error'});
await vite.listen();const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable',args:['--no-sandbox']});
const output=resolve(import.meta.dirname,'../../output/free-trial-ui');await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:950}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin+'/fixture');const start=page.getByRole('button',{name:'Start Auto apply',exact:true});await start.waitFor();await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(n=>n.textContent==='Start Auto apply');return b&&!b.disabled;});
 assert.match(await page.locator('.free-trial-offer').innerText(),/5 free applications.*No job-board connection needed/);assert.equal(await page.getByRole('button',{name:'Open SEEK',exact:true}).count(),0);
 await page.screenshot({path:resolve(output,'desktop-new-user.png'),fullPage:true});
 await start.click();const dialog=page.getByRole('dialog',{name:'Review Auto apply settings'});await dialog.waitFor();assert.match(await dialog.getByRole('button',{name:/Greenhouse/}).getAttribute('class')||'',/\bon\b/);assert.equal(await dialog.getByRole('button',{name:/Workday|PageUp|Jora/}).count(),0);assert.doesNotMatch(await dialog.innerText(),/Sign in on the Apply page first/);
 await dialog.getByRole('button',{name:'Start Auto apply',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.run-review-overlay'));
 assert(writes.some(w=>w.path==='/api/auto-apply'&&w.body.enabled===true&&w.body.applicationMode==='auto'),'employer-only run can start while SEEK and Indeed are disconnected');assert(!writes.some(w=>w.path==='/api/signin/session'));
 for(const width of [390,320]){await page.setViewportSize({width,height:950});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:resolve(output,`phone-${width}.png`),fullPage:true});}
 await page.getByRole('button',{name:'Connect SEEK · +6 free',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('Fixture sign-in only'));assert.equal(writes.filter(w=>w.path==='/api/signin/session').length,1);
 rewarded=true;remaining=11;await page.evaluate(()=>{window.dispatchEvent(new Event('boards-changed'));});await page.getByText('6 extra free applications unlocked',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Connect SEEK · +6 free',exact:true}).count(),0);
 await page.reload();await page.getByText('6 extra free applications unlocked',{exact:true}).waitFor();await page.screenshot({path:resolve(output,'phone-bonus-unlocked.png'),fullPage:true});
 legacy=true;rewarded=false;remaining=5;await page.goto(origin+'/fixture');await start.waitFor();assert(await start.isDisabled());assert.equal(await page.locator('.free-trial-offer').count(),0,'existing accounts retain their original onboarding and offer');
 legacy=false;incomplete=true;await page.goto(origin+'/fixture');await page.getByRole('button',{name:'Finish setup',exact:true}).waitFor();const prior=writes.length;
 await page.getByRole('button',{name:'Connect SEEK · +6 free',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('Fixture sign-in only'));assert(writes.slice(prior).some(w=>w.path==='/api/signin/session'),'optional SEEK connection also opens before resume/profile setup is complete');
 assert.deepEqual(errors,[]);console.log('PASS: employer-only start without board sign-in, optional SEEK reward, live reward refresh, desktop/phone layout and legacy isolation. Fixture APIs only.');console.log('Screenshots: '+output);
}finally{await browser.close();await vite.close();}
