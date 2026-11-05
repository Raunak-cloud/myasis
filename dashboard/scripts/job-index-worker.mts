import { existsSync } from 'node:fs';
import type pg from 'pg';
import type {JobIndexStore} from '../server/job-index/store.js';
import { indexConfig, indexStore, appReader } from '../server/job-index/config.js';
import {minimaxReviewer} from '../server/job-index/review.js';
import {readEnv} from '../server/runner.js';
import { crawlCycle } from '../server/job-index/engine.js';

const controller=new AbortController(),once=process.argv.includes('--once'),migrate=process.argv.includes('--migrate');
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
let reader:pg.Pool|undefined,store:JobIndexStore|null=null,connectedUrl='',readerUrl='',waiting=false;
try {
  do {
    let delayMs=60_000;
    if(!existsSync(new URL('../../.deploying',import.meta.url))||migrate) {
      try {
        const config=indexConfig();
        if(!config) {if(!waiting)console.log('[job-index] awaiting the external Neon connection');waiting=true;if(once)process.exitCode=1;}
        else {
          waiting=false;store=indexStore();if(!store)throw Error('External database is unavailable.');
          if(config.indexUrl!==connectedUrl) {await store.migrate();connectedUrl=config.indexUrl;}
          if(migrate)break;
          if(!reader||readerUrl!==config.appReadUrl){await reader?.end();reader=appReader(config);readerUrl=config.appReadUrl;}
          const stats=await crawlCycle(store,reader,{scheduled:!once,braveKey:config.braveKey,reviewer:minimaxReviewer(store,(process.env.OPENROUTER_API_KEY??readEnv().OPENROUTER_API_KEY??'').trim()),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4*60_000)])});
          const next=typeof stats.nextCrawlAt==='string'?Date.parse(stats.nextCrawlAt):NaN;
          delayMs=Number.isFinite(next)?Math.max(1000,next-Date.now()):5*60_000;
          console.log('[job-index]',JSON.stringify(stats));
        }
      }catch{if(!controller.signal.aborted)console.warn('[job-index] connection or cycle failed; check the configured connection and stored cycle status');if(once||migrate)process.exitCode=1;}
    }
    if(once||migrate||controller.signal.aborted)break;
    await new Promise<void>(resolve=>{const t=setTimeout(done,waiting?60_000:delayMs);function done(){controller.signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);resolve();}controller.signal.addEventListener('abort',abort,{once:true});});
  }while(!controller.signal.aborted);
}finally{await reader?.end();await store?.pool.end();}
