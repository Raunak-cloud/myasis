import { query } from '../db/index.js';
import { readEnv } from '../runner.js';
import { indexConfig } from '../job-index/config.js';
import { createHiringContactSearch, type HiringContactSearch } from './discovery.js';
import type { HrDb } from './store.js';

/** Count HR searches independently of the job catalog, without a daily quota. */
export async function recordHrContactSearch(db:HrDb={query:async(sql,params)=>({rows:await query(sql,params)})}):Promise<void>{
  await db.query(`INSERT INTO hr_contact_search_usage(day,calls) VALUES(current_date,1)
    ON CONFLICT(day) DO UPDATE SET calls=hr_contact_search_usage.calls+1,updated_at=now()`);
}
export function hrSearchConfiguration(env:Record<string,string|undefined>,fallbackBraveKey=''):{provider:'brave'|'serper';key:string}|undefined {
  const selected=(env.HR_SEARCH_PROVIDER??'auto').trim().toLowerCase();
  if(!['auto','serper','brave'].includes(selected))throw Error('Choose auto, serper or brave for HR_SEARCH_PROVIDER.');
  const serper=(env.SERPER_API_KEY??'').trim(),brave=env.BRAVE_SEARCH_API_KEY?.trim()||fallbackBraveKey.trim();
  if(selected==='serper'||selected==='auto'&&serper)return serper?{provider:'serper',key:serper}:undefined;
  return brave?{provider:'brave',key:brave}:undefined;
}
export function hrContactSearch():HiringContactSearch|undefined{
  const env={...readEnv(),...process.env};
  let fallback='';
  if(!env.BRAVE_SEARCH_API_KEY?.trim())try{fallback=indexConfig()?.braveKey?.trim()??'';}catch{/* HR can operate from its own configured key. */}
  const config=hrSearchConfiguration(env,fallback);if(!config)return undefined;
  return createHiringContactSearch({...config,reserveSearch:async()=>{await recordHrContactSearch();return true;}});
}
