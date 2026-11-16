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
export function hrContactSearch():HiringContactSearch|undefined{
  const env={...readEnv(),...process.env};
  let key=(env.BRAVE_SEARCH_API_KEY??'').trim();
  if(!key)try{key=indexConfig()?.braveKey?.trim()??'';}catch{/* HR can operate from its own configured key. */}
  if(!key)return undefined;
  return createHiringContactSearch({key,reserveSearch:async()=>{await recordHrContactSearch();return true;}});
}
