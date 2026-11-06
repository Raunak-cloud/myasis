/** Fixed SSH endpoint for the signed-in local connector; no arbitrary commands. */
import {writeFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {indexStore,indexConfig,appReader} from '../server/job-index/config.js';
import {claimSearch,finishSearch,readyPath,waiting} from '../server/job-index/manual.js';
import {parseLeads,leadSchema,importCodexJobs,MAX_CODEX_PACKET_BYTES} from '../server/job-index/codex-discovery.js';
import {minimaxReviewer} from '../server/job-index/review.js';
import {readEnv} from '../server/runner.js';
import {paidProfiles} from '../server/job-index/accounts.js';

const output=(v:unknown)=>console.log(JSON.stringify(v));
if(existsSync('.deploying')){output({idle:true});process.exit(0);}
writeFileSync(readyPath,'online\n',{mode:0o600});
if(!waiting('codex')){output({idle:true});process.exit(0);}
const store=indexStore(),config=indexConfig();if(!store||!config)throw Error('Job discovery is not connected');
let reader:ReturnType<typeof appReader>|undefined,job:any;
const timer=setInterval(()=>writeFileSync(readyPath,'online\n',{mode:0o600}),10_000);
try{
 job=await claimSearch(store,'codex');if(!job){output({idle:true});}else{
  reader=appReader(config);const {profiles}=await paidProfiles(reader,undefined,await store.cachedProfiles());
  const targets=profiles.map(p=>({keywords:p.searchRoles??p.keywords,skills:p.skills,location:p.location,arrangements:p.arrangements,criteria:p.criteria}));
  output({id:job.id,lease:job.lease,schema:leadSchema,targets});
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  const packet=await new Promise<any>((resolve,reject)=>{
   const deadline=setTimeout(()=>{rl.close();reject(Error('Codex search timed out.'));},10*60_000);
   rl.once('line',line=>{clearTimeout(deadline);try{if(Buffer.byteLength(line)>MAX_CODEX_PACKET_BYTES)throw Error();resolve(JSON.parse(line));}catch{reject(Error('Invalid Codex response.'));}finally{rl.close();}});
   rl.once('close',()=>{clearTimeout(deadline);reject(Error('Codex connection ended before results were received.'));});
  });
  if(packet.id!==job.id||packet.lease!==job.lease)throw Error('Search ownership changed.');
  if(packet.error)throw Error('The Codex search could not finish. Check the local connector and try again.');
  if(!await store.enabled())throw Error('Search paused by the administrator; no results imported.');
  const changed=await store.pool.query("UPDATE manual_searches SET state='running',lease_until=now()+interval '15 minutes' WHERE id=$1 AND lease=$2 AND state='searching' RETURNING id",[job.id,job.lease]);if(!changed.rows.length)throw Error('Search ownership changed.');
  const stats=await importCodexJobs(store,reader,parseLeads(packet.result),minimaxReviewer(store,(process.env.OPENROUTER_API_KEY??readEnv().OPENROUTER_API_KEY??'').trim()),undefined,AbortSignal.timeout(10*60_000));
  await finishSearch(store,job,{...stats,codexUsage:packet.usage??null});output({finished:true,id:job.id,stats});
 }
}catch(e){if(job)await finishSearch(store,job,{},e instanceof Error?e.message:'Codex search failed.');output({failed:true,id:job?.id});process.exitCode=1;}
finally{clearInterval(timer);await reader?.end();await store.pool.end();}
