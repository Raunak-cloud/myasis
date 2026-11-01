/** Trusted broker. MiniMax receives only bounded tracked source and fixed
 * diagnostic codes. It never receives this process's files, DB, key or shell. */
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { RepairPilotDetector, waitingRepairCheckpoint, deploymentAllowsLiveRepair, type RepairIncident } from '../server/repair-pilot.js';
import { REPAIR_EDITABLE_FILES, proposeReviewedRepair, type RepairProposal } from '../server/repair-coder.js';
import { miniMaxRepairModel, reviewRepair } from '../server/repair-model.js';
import { validateRepairProposal, traceProvesNoSend } from '../server/repair-validation.js';
import { repairDistHash, bridgeRepairRuntime, REPAIR_RELEASE_ROOT } from '../server/repair-release.js';

const APP='/home/myasis/myasis', STORE='/var/lib/owtomate-repair', CONFIG='/etc/owtomate-repair-pilot.json';
const INSTALL=resolve(import.meta.dirname,'../..');
const run=promisify(execFile);
const env:Record<string,string>={};
for(const line of readFileSync(APP+'/seek-bot/.env','utf8').split(/\r?\n/)){
  const at=line.indexOf('=');if(at>0&&!line.trim().startsWith('#'))env[line.slice(0,at).trim()]=line.slice(at+1).trim();
}
const {Pool}=createRequire(APP+'/dashboard/package.json')('pg');
const pool=new Pool({connectionString:env.DATABASE_URL,max:3,connectionTimeoutMillis:5000,statement_timeout:8000});
type Config={enabled:boolean;ownerId:string;ownerEmail:string;activatedAt:string;maxCasesPerDay:number;recoveryMode:string};
function config():Config|null{
  try{const s=lstatSync(CONFIG);if(s.isSymbolicLink()||!s.isFile()||s.uid!==0||(s.mode&0o022))return null;
    const c=JSON.parse(readFileSync(CONFIG,'utf8'));
    return c.enabled===true&&c.ownerId==='1'&&c.ownerEmail==='raunak.vision@gmail.com'&&Number.isFinite(Date.parse(c.activatedAt))
      &&c.maxCasesPerDay===2&&c.recoveryMode==='in-run'?c:null;
  }catch{return null;}
}
async function ownerAvailable(){
  const r=await pool.query('SELECT email FROM users WHERE id=1 AND blocked_at IS NULL');
  return r.rows[0]?.email?.toLowerCase()==='raunak.vision@gmail.com'&&(env.ADMIN_EMAILS??'').toLowerCase().split(',').map(x=>x.trim()).includes('raunak.vision@gmail.com');
}
function deploymentBlocksRepair(){
  try{return !deploymentAllowsLiveRepair(readFileSync(APP+'/.deploying','utf8'));}
  catch(error:any){return error.code!=='ENOENT';}
}
async function caseActive(runId:string){
  if(!config()||deploymentBlocksRepair()||!await ownerAvailable())return false;
  const r=await pool.query('SELECT r.finished_at,r.stopped,r.trigger,s.enabled FROM run_starts r LEFT JOIN application_schedules s ON s.user_id=r.user_id WHERE r.id=$1 AND r.user_id=1',[runId]);
  const expired=runDiagnostics(runId).some(e=>['repair_expired','repair_cancelled'].includes(e.category));
  return Boolean(r.rows[0]&&!r.rows[0].finished_at&&!r.rows[0].stopped&&!expired&&(r.rows[0].trigger!=='auto'||r.rows[0].enabled===true));
}
async function setState(id:string,status:string,detail:string,extra:Record<string,unknown>={}){
  const result=await pool.query('UPDATE repair_pilot_cases SET status=$2,detail=$3,updated_at=now(),base_sha=coalesce($4,base_sha),artifact_hash=coalesce($5,artifact_hash),patch_hash=coalesce($6,patch_hash) WHERE id=$1 RETURNING run_id::text,attempt_id::text',
    [id,status,detail,extra.baseSha??null,extra.artifactHash??null,extra.patchHash??null]);
  if(['blocked','cancelled','complete'].includes(status)&&result.rows[0])writeTicket({caseId:id,runId:result.rows[0].run_id,attemptId:result.rows[0].attempt_id,status,expiresAt:Date.now()+3600_000});
  console.log(JSON.stringify({caseId:id,status,detail}));
}
function writeTicket(ticket:Record<string,unknown>){
  const dir=resolve(REPAIR_RELEASE_ROOT,'tickets');mkdirSync(dir,{recursive:true,mode:0o755});chmodSync(dir,0o755);
  const path=resolve(dir,`${ticket.runId}-${ticket.attemptId}.json`),temporary=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(ticket),{mode:0o644});chmodSync(temporary,0o644);renameSync(temporary,path);
}
function runDiagnostics(runId:string):any[]{
  if(!/^\d+$/.test(runId))return [];
  try{const file=APP+`/seek-bot/data/users/1/traces/run-${runId}.diagnostics.jsonl`,stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10_000_000)return [];
    return readFileSync(file,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  }catch{return [];}
}
async function git(args:string[],encoding:'utf8'|'buffer'='utf8'){
  return await run('git',['-c',`safe.directory=${APP}`,'-C',APP,...args],{encoding,maxBuffer:50_000_000,timeout:20_000});
}
function readTrace(runId:string,attemptId:string):any|null{
  if(!/^\d+$/.test(runId)||!/^[a-f0-9-]{36}$/.test(attemptId))return null;
  try{const p=APP+`/seek-bot/data/users/1/traces/attempt-${attemptId}.json`,s=lstatSync(p);
    if(!s.isFile()||s.isSymbolicLink()||s.size>40_000_000)return null;
    const t=JSON.parse(readFileSync(p,'utf8'));return String(t.runStartId)===runId&&t.attemptId===attemptId?t:null;
  }catch{return null;}
}
async function snapshot(id:string,baseSha:string,proposal:RepairProposal){
  const path=resolve(STORE,'cases',id);mkdirSync(path,{mode:0o755});
  const archive=resolve(STORE,'cases',id+'.tar');
  const data=await git(['archive','--format=tar',baseSha],'buffer');writeFileSync(archive,data.stdout,{mode:0o600});
  await run('tar',['-xf',archive,'-C',path],{timeout:20_000});
  for(const [file,content]of Object.entries(proposal.files)){
    if(!(REPAIR_EDITABLE_FILES as readonly string[]).includes(file)||lstatSync(resolve(path,file)).isSymbolicLink())throw Error('Unapproved repair path.');
    writeFileSync(resolve(path,file),content,{mode:0o644});
  }
  chmodSync(path,0o755);
  return path;
}
async function validate(id:string){
  const log=resolve(STORE,'cases',id+'.validation.log');
  try{const result=await run('bash',[resolve(INSTALL,'deploy/repair-pilot-sandbox.sh'),id],{timeout:270_000,maxBuffer:8_000_000});writeFileSync(log,result.stdout+'\n'+result.stderr,{mode:0o600});}
  catch(error:any){writeFileSync(log,String(error.stdout??'')+'\n'+String(error.stderr??''),{mode:0o600});throw Error('Isolated validation failed; no release published.');}
}
async function publish(row:any){
  if(deploymentBlocksRepair())return;
  if(!config()||!await ownerAvailable())throw Error('Pilot paused or owner unavailable.');
  const current=String((await git(['rev-parse','HEAD'])).stdout).trim();
  if(current!==row.base_sha)throw Error('Production revision changed; validated repair is stale.');
  const release=resolve(REPAIR_RELEASE_ROOT,row.id);mkdirSync(REPAIR_RELEASE_ROOT,{recursive:true,mode:0o755});
  const bot=resolve(release,'seek-bot');
  await run('python3',[resolve(INSTALL,'deploy/repair-unpack.py'),resolve(STORE,'cases',row.id+'.result/dist.tar'),bot],{timeout:30_000});
  symlinkSync(APP+'/seek-bot/node_modules',resolve(bot,'node_modules'));
  bridgeRepairRuntime(bot,APP+'/seek-bot');
  writeFileSync(resolve(bot,'package.json'),'{"type":"module"}',{mode:0o644});chmodSync(resolve(bot,'package.json'),0o644);
  const distHash=repairDistHash(resolve(bot,'dist'));
  const lockHash=createHash('sha256').update(readFileSync(APP+'/seek-bot/package-lock.json')).digest('hex');
  writeFileSync(resolve(release,'manifest.json'),JSON.stringify({caseId:row.id,ownerId:'1',baseSha:row.base_sha,distHash,lockHash,expiresAt:Date.now()+2*60*60*1000}),{mode:0o644});
  chmodSync(resolve(release,'manifest.json'),0o644);
  const trace=readTrace(row.run_id,row.attempt_id);
  if(!trace||!traceProvesNoSend(trace,row.run_id,row.attempt_id)||!await caseActive(row.run_id))throw Error('In-run checkpoint is no longer safe or active.');
  await setState(row.id,'in_run_ready','Validated build is ready for the paused application in its original run.',{artifactHash:distHash});
  writeTicket({caseId:row.id,runId:row.run_id,attemptId:row.attempt_id,status:'in_run_ready',jobId:trace.jobId,mode:trace.mode,
    baseSha:row.base_sha,distHash,expiresAt:Date.now()+3600_000});
}
async function advance(){
  const result=await pool.query("SELECT c.*,c.id::text,c.run_id::text,c.attempt_id::text,r.finished_at,r.stopped,r.trigger,s.enabled AS schedule_enabled,s.application_mode AS schedule_mode FROM repair_pilot_cases c JOIN run_starts r ON r.id=c.run_id AND r.user_id=c.user_id LEFT JOIN application_schedules s ON s.user_id=c.user_id WHERE c.user_id=1 AND c.status IN ('waiting_run','in_run_ready','in_run_running','retry_started') ORDER BY c.created_at LIMIT 1");
  const row=result.rows[0];if(!row)return;
  if(row.status==='retry_started'){
    const retry=await pool.query('SELECT finished_at,started_at FROM run_starts WHERE id=$1 AND user_id=1',[row.retry_run_id]);
    if(retry.rows[0]?.finished_at){
      const original=readTrace(row.run_id,row.attempt_id);
      const outcomes=original?.jobId?await pool.query("SELECT EXISTS(SELECT 1 FROM applications WHERE user_id=1 AND job_id=$1 AND applied_at >= $2) submitted,EXISTS(SELECT 1 FROM application_reviews WHERE user_id=1 AND payload->'job'->>'id'=$1 AND status='ready' AND updated_at >= $2) prepared",[original.jobId,retry.rows[0].started_at]):{rows:[]};
      const result=outcomes.rows[0],success=result?.submitted||result?.prepared;
      await setState(row.id,success?'complete':'blocked',result?.submitted?'Database confirms the admin retry submission; inspect its employer receipt in the normal trace.':result?.prepared?'Database confirms an application prepared for candidate confirmation.':'The one allowed admin retry has no confirmed database submission or preparation. No further retry is queued.');
    }
    return;
  }
  if(!config()||row.stopped||row.trigger==='auto'&&row.schedule_enabled!==true){await setState(row.id,'cancelled','Run stopped or pilot/schedule paused.');return;}
  const events=runDiagnostics(row.run_id).filter(e=>e.runStartId===row.run_id&&e.relatedAttemptId===row.attempt_id);
  const resumed=events.find(e=>e.category==='repair_resumed'&&e.repairCaseId===row.id);
  if(row.status==='in_run_ready'||row.status==='in_run_running'){
    if(row.finished_at){
      const original=readTrace(row.run_id,row.attempt_id);
      const outcomes=original?.jobId?await pool.query("SELECT EXISTS(SELECT 1 FROM applications WHERE user_id=1 AND job_id=$1 AND applied_at >= $2) submitted,EXISTS(SELECT 1 FROM application_reviews WHERE user_id=1 AND payload->'job'->>'id'=$1 AND status='ready' AND updated_at >= $2) prepared",[original.jobId,row.created_at]):{rows:[]};
      const outcome=outcomes.rows[0];await setState(row.id,outcome?.submitted||outcome?.prepared?'complete':'blocked',outcome?.submitted?'Database confirms a submission recovered inside the original run.':outcome?.prepared?'Database confirms a preparation recovered inside the original run.':'Original run finished without a confirmed recovered submission or preparation.');return;
    }
    if(resumed&&row.status==='in_run_ready')await setState(row.id,'in_run_running','Existing application resumed in its original run.');
    if(!resumed&&Date.now()-new Date(row.updated_at).getTime()>6*60_000)await setState(row.id,'cancelled','Application did not consume its in-run repair ticket. No separate run is queued.');
    return;
  }
  if(row.finished_at){await setState(row.id,'cancelled','Original run already finished; no separate recovery run will start.');return;}
  const trace=readTrace(row.run_id,row.attempt_id);
  if(trace?.outcome?.status==='applied'||trace?.outcome?.status==='prepared'){await setState(row.id,'cancelled','The application agent recovered without a code release.');return;}
  const waiting=events.find(e=>e.category==='repair_waiting');
  if(!waiting){if(Date.now()-new Date(row.created_at).getTime()>6*60_000)await setState(row.id,'cancelled','No live application checkpoint is waiting.');return;}
  if(Date.now()-Date.parse(waiting.at)>6*60_000||events.some(e=>['repair_expired','repair_cancelled'].includes(e.category))){await setState(row.id,'cancelled','Application checkpoint expired or was cancelled.');return;}
  if(!trace||!traceProvesNoSend(trace,row.run_id,row.attempt_id)){await setState(row.id,'blocked','Prior send state is uncertain or the attempt is not safely resumable.');return;}
  if(row.trigger==='auto'&&row.schedule_mode!==(trace.mode==='prepare'?'semi-auto':'auto')){await setState(row.id,'cancelled','Schedule application mode changed.');return;}
  const blocked=await pool.query("SELECT 1 FROM applications WHERE user_id=1 AND job_id=$1 UNION ALL SELECT 1 FROM run_events WHERE user_id=1 AND job_id=$1 AND status='needs-human' AND ts >= $2 LIMIT 1",[trace.jobId,row.created_at]);
  if(blocked.rows.length){await setState(row.id,'blocked','An application or unresolved candidate question already exists.');return;}
  if(trace.mode==='approved'){
    const approved=await pool.query("SELECT 1 FROM application_reviews WHERE user_id=1 AND payload->'job'->>'id'=$1 AND status='approved' AND payload->>'revision'=$2",[trace.jobId,trace.sendAudit?.approvedRevision??'']);
    if(!trace.sendAudit?.approvedRevision||approved.rows.length!==1){await setState(row.id,'blocked','Exact candidate-approved revision is no longer active.');return;}
  }
  if(Date.now()-new Date(row.created_at).getTime()>2*60*60*1000){await setState(row.id,'blocked','Repair expired while waiting for the run.');return;}
  // A separate immutable build changes no loaded/shared production code.
  await publish(row);
}
async function discover(){
  if(deploymentBlocksRepair())return;
  const c=config();if(!c||!await ownerAvailable())return;
  const daily=await pool.query("SELECT count(*)::int n FROM repair_pilot_cases WHERE user_id=1 AND (created_at AT TIME ZONE 'Australia/Sydney')::date=(now() AT TIME ZONE 'Australia/Sydney')::date");
  if(daily.rows[0].n>=c.maxCasesPerDay)return;
  const runs=await pool.query("SELECT id::text,started_at,stopped,trigger FROM run_starts r WHERE user_id=1 AND mode='live' AND finished_at IS NULL AND repair_case_id IS NULL AND started_at >= $1 AND stopped IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM repair_pilot_cases c WHERE c.run_id=r.id OR c.retry_run_id=r.id) ORDER BY started_at DESC LIMIT 5",[c.activatedAt]);
  for(const r of runs.rows){
    if(r.trigger==='auto'){
      const s=await pool.query('SELECT enabled FROM application_schedules WHERE user_id=1');if(s.rows[0]?.enabled!==true)continue;
    }
    const file=APP+`/seek-bot/data/users/1/traces/run-${r.id}.diagnostics.jsonl`;
    if(!existsSync(file)||lstatSync(file).isSymbolicLink()||lstatSync(file).size>10_000_000)continue;
    const detector=new RepairPilotDetector('1','raunak.vision@gmail.com',true);
    const events=runDiagnostics(r.id);
    for(const line of readFileSync(file,'utf8').split('\n')){
      let event;try{event=JSON.parse(line)}catch{continue}
      const incident=detector.observe(r.id,event);if(!incident)continue;
      const trace=readTrace(r.id,incident.attemptId);
      if(trace?.outcome?.status==='applied'||trace?.outcome?.status==='prepared'||trace?.outcome?.status==='needs-human')continue;
      if(!waitingRepairCheckpoint(r.id,incident.attemptId,events)||!trace||!traceProvesNoSend(trace,r.id,incident.attemptId))continue;
      const id=randomUUID();
      const inserted=await pool.query("INSERT INTO repair_pilot_cases(id,user_id,run_id,attempt_id,status,incident) VALUES($1,1,$2,$3,'coding',$4) ON CONFLICT(run_id) DO NOTHING RETURNING id",[id,r.id,incident.attemptId,JSON.stringify(incident)]);
      if(inserted.rows.length)await repair(id,incident);
      return;
    }
  }
}
async function repair(id:string,incident:RepairIncident){
  let cost=0;
  const charge=async(n:number)=>{cost+=n;await pool.query('UPDATE repair_pilot_cases SET cost_usd=$2,updated_at=now() WHERE id=$1',[id,cost]);if(cost>.50)throw Error('Repair case spending limit reached.');};
  try{
    const baseSha=String((await git(['rev-parse','HEAD'])).stdout).trim();
    const source:Record<string,string>={};for(const path of REPAIR_EDITABLE_FILES)source[path]=String((await git(['show',`${baseSha}:${path}`])).stdout);
    const provider=miniMaxRepairModel(env.OPENROUTER_API_KEY??'',undefined,()=>caseActive(incident.runId));
    const proposal=await proposeReviewedRepair(incident,source,async turns=>{
      if(!await caseActive(incident.runId))throw Error('Pilot or schedule paused.');
      const r=await provider(turns);await charge(r.costUsd);
      const prior=turns.at(-1)?.content??'';
      appendFileSync(resolve(STORE,'cases',id+'.coding.jsonl'),JSON.stringify({at:new Date().toISOString(),costUsd:r.costUsd,
        rejection:prior.startsWith('Rejected:')?prior.slice(0,300):undefined,
        calls:r.calls.map(call=>({name:call.name,path:call.args.path,oldChars:typeof call.args.old==='string'?call.args.old.length:undefined,
          replacementChars:typeof call.args.replacement==='string'?call.args.replacement.length:undefined}))})+'\n',{mode:0o600});
      return r;
    },async(candidate,attempt)=>{
      if(!await caseActive(incident.runId))throw Error('Pilot or schedule paused, or release in progress.');
      writeFileSync(resolve(STORE,'cases',id+`.proposal-${attempt}.json`),JSON.stringify(candidate),{mode:0o600});
      const review=await reviewRepair(env.OPENROUTER_API_KEY??'',incident,source,candidate,undefined,()=>caseActive(incident.runId));await charge(review.costUsd);
      writeFileSync(resolve(STORE,'cases',id+`.review-${attempt}.json`),JSON.stringify(review),{mode:0o600});
      return review;
    },validateRepairProposal);
    writeFileSync(resolve(STORE,'cases',id+'.proposal.json'),JSON.stringify(proposal),{mode:0o600});
    if(!await caseActive(incident.runId))throw Error('Pilot or schedule paused.');
    await setState(id,'testing','Code proposal accepted for isolated validation.',{baseSha});
    await snapshot(id,baseSha,proposal);
    await validate(id);
    const patchHash=createHash('sha256').update(JSON.stringify(proposal.files)).digest('hex');
    await setState(id,'waiting_run','Isolated validation passed; waiting for the safe checkpoint inside the original run.',{patchHash});
  }catch(error:any){
    if(Number.isFinite(error.repairCostUsd)) {cost+=error.repairCostUsd;await pool.query('UPDATE repair_pilot_cases SET cost_usd=$2 WHERE id=$1',[id,cost]);}
    if(error.repairUsageUnknown||/usage|charge.*unavailable|fetch failed|timeout|aborted/i.test(error.message??''))await pool.query('UPDATE repair_pilot_cases SET cost_unknown=true WHERE id=$1',[id]);
    await setState(id,'blocked',String(error.message??'Repair failed').replaceAll(env.OPENROUTER_API_KEY??'__no_key__','[credential withheld]').slice(0,500));
  }
}
async function main(){
  if(process.getuid?.()!==0)throw Error('The repair broker requires its installed root service.');
  mkdirSync(STORE,{recursive:true,mode:0o700});mkdirSync(resolve(STORE,'cases'),{recursive:true,mode:0o700});
  const lock=await pool.connect();
  const held=await lock.query('SELECT pg_try_advisory_lock(726303,1) held');
  if(!held.rows[0]?.held)throw Error('Another repair broker already holds the admin pilot lock.');
  lock.on('error',()=>process.exit(1));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void pool.end().finally(()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();});
  // A runner may have started just before a broker restart. Never queue it again.
  await pool.query("UPDATE repair_pilot_cases c SET status='retry_started',retry_run_id=r.id,detail='Existing repair retry reconciled after restart.',updated_at=now() FROM run_starts r WHERE c.user_id=1 AND r.user_id=1 AND r.repair_case_id=c.id AND c.status='retry_claimed'");
  // Never resume an interrupted code/test/publish transaction as if it passed.
  const interrupted=await pool.query("SELECT id::text FROM repair_pilot_cases WHERE user_id=1 AND status IN ('coding','testing','retry_claimed')");
  for(const row of interrupted.rows)await setState(row.id,'blocked','Repair broker restarted during an unfinished transaction.');
  console.log('Admin repair pilot broker ready: account 1, MiniMax, maximum two cases per day.');
  for(;;){try{await advance();await discover();}catch(error:any){console.error('Repair broker tick failed:',String(error.message??error).slice(0,300));}
    await new Promise(resolve=>setTimeout(resolve,10_000));}
}
await main();
