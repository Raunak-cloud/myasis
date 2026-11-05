import {existsSync} from 'node:fs';
import {indexConfig,indexStore,appReader} from '../server/job-index/config.js';
import {minimaxReviewer} from '../server/job-index/review.js';
import {readEnv} from '../server/runner.js';
import {crawlCycle} from '../server/job-index/engine.js';
import {waiting,claimSearch,finishSearch} from '../server/job-index/manual.js';

const controller=new AbortController(),once=process.argv.includes('--once'),migrate=process.argv.includes('--migrate');
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
let store:ReturnType<typeof indexStore>=null,reader:ReturnType<typeof appReader>|undefined;
try{
 do{
  // Idle file checks allow Neon to suspend. A clock or service restart never
  // creates a search request; collection requires an administrator's click.
  if((!existsSync(new URL('../../.deploying',import.meta.url))&&(once||waiting('brave')))||migrate){
   try{
    const config=indexConfig();store=indexStore();if(!config||!store)throw Error('Connect the external job database.');
    if(migrate){await store.migrate();break;}
    const job=once?null:await claimSearch(store,'brave');
    if(once||job){
     reader=appReader(config);const started=new Date();
     try{
      const stats=await crawlCycle(store,reader,{braveKey:config.braveKey,reviewer:minimaxReviewer(store,(process.env.OPENROUTER_API_KEY??readEnv().OPENROUTER_API_KEY??'').trim()),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4*60_000)])});
      const count=(await store.pool.query('SELECT count(*)::int AS count FROM indexed_jobs WHERE first_seen_at>=$1',[started])).rows[0].count;
      if(job)await finishSearch(store,job,{...stats,newJobs:count},controller.signal.aborted?'Search interrupted by a service update. Saved matches remain available.':undefined);
      console.log('[job-index]',JSON.stringify({...stats,newJobs:count}));
     }catch{if(job)await finishSearch(store,job,{},'The search could not finish. Check source availability and retry.');if(once)process.exitCode=1;}
     finally{await reader.end();reader=undefined;}
    }
   }catch{console.warn('[job-index] manual search unavailable; check connection and request status');if(once||migrate)process.exitCode=1;}
  }
  if(once||migrate||controller.signal.aborted)break;
  await new Promise<void>(resolve=>{const t=setTimeout(done,5000);function done(){controller.signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);done();}controller.signal.addEventListener('abort',abort,{once:true});});
 }while(!controller.signal.aborted);
}finally{await reader?.end();await store?.pool.end();}
