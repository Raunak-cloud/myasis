import type {IncomingMessage,ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {currentUser,type SessionUser} from './auth.js';
import {isAdmin} from './admin-access.js';
import {one} from './db/index.js';
import {runner,readEnv,accountApplicationEnvironment,deploying} from './runner.js';
import {userDir,userChromeDir} from './userdata.js';
import {crossSite,readRawBodyLimited,rateLimited} from './http-guards.js';
import {gmailAccess} from './gmail-access.js';
import {gmailRunConnection} from './gmail-mcp.js';
import {GmailMcpClient} from '../../seek-bot/src/gmail-mcp-client.js';
import {digestConfig} from './digest.js';
import {browserRoute} from './route.js';
import {SigninDesktop} from './signin-desktop.js';
import {sessionFor} from './signin.js';
import {superviseRun} from './run-watchdog.js';
import {FormLab,formCatalog} from './form-lab/engine.mjs';
import {formsPage} from './form-lab/page.js';

const identifier=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
interface Metadata {id:string;owner:string;key:string;email:string;seed:number;model:'celeris'|'minimax';status:string;createdAt:string;finishedAt?:string;error?:string;agent:boolean}
interface Entry {meta:Metadata;lab:FormLab;directory:string;secret:string;token?:string;stop?:()=>void;finished?:Promise<void>;stopped?:boolean;busy?:boolean}
const entries=new Map<string,Entry>();
const safeRead=(file:string):any=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const safeMessage=(value:unknown)=>String(value).replace(/(?:sk-or-v1-|sk-)[A-Za-z0-9_-]+/g,'[credential]').replace(/\b\d{6}\b/g,'[code]').slice(0,1600);
function save(entry:Entry){
 const file=join(entry.directory,'private.json'),temp=file+'.tmp';
 writeFileSync(temp,JSON.stringify({meta:entry.meta,secret:entry.secret,state:entry.lab.state}),{mode:0o600});renameSync(temp,file);
}
function load(owner:string,id:string):Entry|null{
 if(!identifier.test(id))return null;
 const active=entries.get(id);if(active)return active.meta.owner===owner?active:null;
 const directory=resolve(userDir(owner),'form-tests',id),saved=safeRead(join(directory,'private.json'));
 if(!saved||saved.meta?.owner!==owner||saved.meta?.id!==id)return null;
 if(['starting','running','stopping'].includes(saved.meta.status)){saved.meta.status='interrupted';saved.meta.error='The server restarted before this test completed.';}
 const entry:Entry={directory,meta:saved.meta,secret:saved.secret,lab:new FormLab({key:saved.meta.key,email:saved.meta.email,seed:saved.meta.seed,id,secret:saved.secret,state:saved.state})};
 entries.set(id,entry);return entry;
}
function details(entry:Entry){
 const result=safeRead(join(entry.directory,'result.json')),worker=safeRead(join(entry.directory,'worker-status.json'));
 let cost=0,unknown=0;const bases=new Set<string>();const diagnostics:Array<Record<string,unknown>>=[];
 const ledger=join(entry.directory,'data/cost-ledger.jsonl');
 if(existsSync(ledger))for(const line of readFileSync(ledger,'utf8').split('\n').filter(Boolean)){
  try{const record=JSON.parse(line);if(record.kind!=='usage')continue;if(typeof record.amountUsd==='number')cost+=record.amountUsd;else unknown++;bases.add(record.basis);}catch{/* currently appended line */}
 }
 const traces=join(entry.directory,'data/traces');if(existsSync(traces))for(const name of readdirSync(traces).filter(name=>name.endsWith('.diagnostics.jsonl'))){
  for(const line of readFileSync(join(traces,name),'utf8').split('\n').filter(Boolean))try{const event=JSON.parse(line);if(event.severity!=='info')diagnostics.push({at:event.at,step:event.step,tool:event.tool,category:event.category,message:safeMessage(event.message)});}catch{/* currently appended line */}
 }
 return {...entry.meta,...entry.lab.summary(),costUsd:Number(cost.toFixed(6)),costBasis:bases.size===1&&bases.has('provider')?'provider-reported':'estimated',unknownCharges:unknown,elapsedMs:result?.elapsedMs??worker?.elapsedMs??0,modelCalls:result?.modelCalls??worker?.modelCalls??0,agentOutcome:result?.result?.outcome??null,error:entry.meta.error||result?.error,diagnostics:diagnostics.slice(-100),url:'/forms/attempts/'+entry.meta.id+'/page/1',hasScreenshot:existsSync(join(entry.directory,'latest.png'))};
}
async function sendCode(entry:Entry,message:{to:string;subject:string;text:string}){
 const access=await gmailAccess(entry.meta.owner),config=digestConfig();
 if(!access.connected||access.account!==entry.meta.email||message.to!==entry.meta.email||!config)throw Error('Connect this admin’s Gmail and configure the notification sender before testing verification.');
 if(rateLimited('form-lab-mail:'+entry.meta.owner,12,60*60_000))throw Error('The test-email hourly limit was reached.');
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json','Idempotency-Key':'form-lab/'+entry.meta.id+'/'+entry.lab.state.mailCount},body:JSON.stringify({from:config.from,to:[message.to],subject:message.subject,text:message.text}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('The test verification email could not be delivered.');
}
async function execute(entry:Entry){
 let desktop:SigninDesktop|undefined,transport:any,lease:Awaited<ReturnType<typeof gmailRunConnection>>|undefined;
 try{
  const env=await accountApplicationEnvironment(entry.meta.owner,{APPLICATION_AI_MODEL:entry.meta.model});
  if(entry.stopped)throw Error('Test cancelled.');
  if(entry.lab.definition.account){
   const access=await gmailAccess(entry.meta.owner);if(!access.connected||access.account!==entry.meta.email)throw Error('Reconnect the admin Gmail account before this test.');
   let port:number|undefined;
   if(access.provider==='browser'){
    const route=await browserRoute(entry.meta.owner);
    desktop=new SigninDesktop({profileDir:userChromeDir(entry.meta.owner),chromePath:readEnv().CHROME_PATH?.trim()||'/usr/bin/google-chrome',routeArgs:route.args,startUrl:'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(entry.meta.email),password:randomBytes(20).toString('hex')});
    await desktop.start();port=desktop.debugPort;
    const {chromium}=createRequire(new URL('../../seek-bot/package.json',import.meta.url))('patchright');
    transport=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:30000});
   }
   lease=await gmailRunConnection(entry.meta.owner,[],port);
   const client=new GmailMcpClient({url:lease.env.GMAIL_MCP_URL,token:lease.env.GMAIL_MCP_TOKEN,account:entry.meta.email});
   try{await client.search('subject:"Owtomate synthetic test" newer_than:1d');}finally{await client.close();}
  }
  if(entry.stopped||deploying())throw Error(entry.stopped?'Test cancelled.':'A deployment started. Start a new test after it completes.');
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'form-lab/worker.mjs')],{cwd:resolve(import.meta.dirname,'../..'),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,USER:process.env.USER,LANG:process.env.LANG,NODE_ENV:process.env.NODE_ENV,...env,GMAIL_MCP_URL:'',GMAIL_MCP_TOKEN:'',GMAIL_MCP_ACCOUNT:'',GMAIL_ACCESS_MODE:'off',...lease?.env,
   CHROME_PATH:readEnv().CHROME_PATH,FORM_LAB_OUTPUT:entry.directory,FORM_LAB_ID:entry.meta.id,FORM_LAB_KEY:entry.meta.key,FORM_LAB_EMAIL:entry.meta.email,FORM_LAB_TOKEN:entry.token!,FORM_LAB_BACKEND:'http://127.0.0.1:'+(process.env.PORT||5180)}});
  entry.meta.status='running';save(entry);
  const log=(chunk:Buffer)=>appendFileSync(join(entry.directory,'worker.log'),chunk,{mode:0o600});child.stdout?.on('data',log);child.stderr?.on('data',log);
  const supervisor=superviseRun(child,{timeoutMs:26*60_000,onTimeout:()=>{entry.meta.error='The synthetic test time limit was reached.';},onEscalation:()=>{entry.meta.error='The test worker required forced shutdown.';},onError:error=>{entry.meta.error=safeMessage(error.message);},onFinish:async()=>{
   const result=safeRead(join(entry.directory,'result.json'));entry.meta.error ||= result?.error;
   const confirmed=result?.result?.outcome?.status==='rehearsed'&&result.result.outcome.stoppedAt?.startsWith('Agent judgement: applied.');
   entry.meta.status=entry.stopped?'stopped':entry.lab.state.completed.length===15&&entry.lab.state.receipt&&result?.receiptVisible&&confirmed?'passed':entry.meta.error?'error':'incomplete';
  }});
  entry.stop=()=>{entry.stopped=true;entry.meta.status='stopping';supervisor.stop();save(entry);};
  if(entry.stopped)supervisor.stop();await supervisor.finished;
 }catch(error){entry.meta.status=entry.stopped?'stopped':'error';entry.meta.error=safeMessage((error as Error).message);}
 finally{
  try{lease?.revoke();await transport?.close().catch(()=>{});await desktop?.stop().catch(()=>{});}
  finally{entry.token=undefined;entry.stop=undefined;entry.meta.finishedAt=new Date().toISOString();runner.releaseStart(entry.meta.owner);save(entry);}
 }
}
export async function stopFormTests(){
 const active=[...entries.values()].filter(entry=>entry.finished&&!entry.meta.finishedAt);
 for(const entry of active){entry.stopped=true;entry.stop?.();}
 await Promise.allSettled(active.map(entry=>entry.finished!));
}
export async function formAdminAction(actor:SessionUser,path:string,method:string,body:any={}){
 if(!isAdmin(actor.email))return {status:403,body:{error:'Admins only.'}};
 if(path==='/forms'&&method==='GET'){
  const dir=resolve(userDir(actor.id),'form-tests');const attempts=existsSync(dir)?readdirSync(dir).filter(id=>identifier.test(id)).flatMap(id=>{const entry=load(actor.id,id);return entry?[details(entry)]:[];}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30):[];
  const access=await gmailAccess(actor.id);return {status:200,body:{forms:formCatalog,attempts,gmailConnected:access.connected,mailbox:access.account,mailSenderConfigured:Boolean(digestConfig()),active:runner.activeCount(),baseBudgetUsd:0.20,maximumBudgetUsd:0.70}};
 }
 if(path==='/forms'&&method==='POST'){
  const definition=formCatalog.find(form=>form.key===body.key);
  if(!definition||!['preview','run'].includes(body.action)||!['celeris','minimax'].includes(body.model))return {status:400,body:{error:'Choose a form, model and test action.'}};
  if(rateLimited('form-lab-create:'+actor.id,20,60*60_000))return {status:429,body:{error:'The hourly form-test limit was reached.'}};
  if(body.action==='run'&&body.confirm!==true)return {status:400,body:{error:'Confirm the model spending allowance before starting this test.'}};
  const access=await gmailAccess(actor.id);
  if(definition.account&&(!access.connected||!access.account||!digestConfig()))return {status:400,body:{error:'Connect Gmail and configure the notification sender before testing account creation.'}};
  const agent=body.action==='run';
  if(agent&&(deploying()||sessionFor(actor.id)||!runner.claimStart(actor.id)))return {status:409,body:{error:'Wait for this account’s current browser session or the server’s active runs to finish.'}};
  try{
   const id=randomUUID(),email=access.account||'alex.morgan@example.invalid',seed=918374621,directory=resolve(userDir(actor.id),'form-tests',id),secret=randomBytes(32).toString('hex');
   mkdirSync(directory,{recursive:true,mode:0o700});
   const entry:Entry={directory,secret,meta:{id,owner:actor.id,key:definition.key,email,seed,model:body.model,status:agent?'starting':'manual',createdAt:new Date().toISOString(),agent},lab:new FormLab({key:definition.key,email,seed,id,secret}),token:agent?randomBytes(32).toString('hex'):undefined};
   entries.set(id,entry);save(entry);if(agent)entry.finished=execute(entry).catch(error=>{entry.meta.status='error';entry.meta.error=safeMessage((error as Error).message);console.error('[form-lab] Test cleanup failed:',entry.meta.id);});
   return {status:201,body:details(entry)};
  }catch(error){if(agent)runner.releaseStart(actor.id);throw error;}
 }
 const match=path.match(/^\/forms\/([^/]+)(\/stop)?$/);
 if(match){const entry=load(actor.id,match[1]);if(!entry)return {status:404,body:{error:'Test not found.'}};
  if(method==='GET')return {status:200,body:details(entry)};
  if(method==='POST'&&match[2]==='/stop'){entry.stopped=true;entry.meta.status='stopping';entry.stop?.();save(entry);return {status:200,body:details(entry)};}
 }
 return {status:404,body:{error:'Unknown form-test action.'}};
}
/** All HTML, assets and submissions are protected, including worker requests. */
export async function handleFormsRequest(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
 const url=new URL(req.url||'/', 'http://forms.local');if(url.pathname!=='/forms'&&!url.pathname.startsWith('/forms/'))return false;
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const deny=(status:number,message:string)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(message);return true;};
 if(req.method!=='GET'&&crossSite(req))return deny(403,'Cross-site requests are not accepted.');
 const match=url.pathname.match(/^\/forms\/attempts\/([^/]+)(\/.*)$/);
 const token=req.headers['x-owtomate-form-test'];let entry:Entry|null=null;
 if(token&&match&&typeof token==='string'){
  entry=entries.get(match[1])||null;
  if(!entry?.token||Date.now()-Date.parse(entry.meta.createdAt)>30*60_000||token.length!==entry.token.length||!timingSafeEqual(Buffer.from(createHash('sha256').update(token).digest()),Buffer.from(createHash('sha256').update(entry.token).digest())))return deny(403,'Invalid or expired test capability.');
  const owner=await one<{email:string}>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL',[entry.meta.owner]);if(!owner||!isAdmin(owner.email))return deny(403,'Admin access was revoked.');
 }else{
  const actor=await currentUser(req.headers.cookie);if(!actor)return deny(401,'Sign in as an administrator to open form tests.');if(!isAdmin(actor.email))return deny(403,'Admins only.');
  if(url.pathname==='/forms'||url.pathname==='/forms/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(formsPage());return true;}
  if(match)entry=load(actor.id,match[1]);
 }
 if(!entry||!match)return deny(404,'Form test not found.');
 if(match[2]==='/screenshot'){
  const file=join(entry.directory,'latest.png');if(!existsSync(file))return deny(404,'No screenshot has been captured yet.');res.writeHead(200,{'Content-Type':'image/png'});res.end(readFileSync(file));return true;
 }
 if(entry.busy)return deny(409,'This test is saving a request. Wait, then inspect the current page.');
 entry.busy=true;
 try{
  const body=req.method==='POST'?await readRawBodyLimited(req,10_000_000):undefined;
  const response=await entry.lab.request({method:req.method||'GET',path:match[2],query:url.search,body,contentType:req.headers['content-type']},message=>sendCode(entry!,message));
  save(entry);res.writeHead(response.status,response.headers);res.end(response.body);return true;
 }catch(error){return deny(400,safeMessage((error as Error).message));}
 finally{entry.busy=false;}
}
