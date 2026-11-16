import { query } from '../db/index.js';
import { readEnv } from '../runner.js';
import { indexConfig } from '../job-index/config.js';
import { createHiringContactSearch, type HiringContactSearch } from './discovery.js';
import type { HrDb } from './store.js';

/** A separate allowance prevents HR follow-ups consuming the job catalog's
 * search budget. Atomic reservations are still required before every query. */
export async function reserveHrContactSearch(db:HrDb={query:async(sql,params)=>({rows:await query(sql,params)})},limit=50):Promise<boolean>{
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid HR search allowance.');
  return (await db.query(`INSERT INTO hr_contact_search_usage(day,calls) VALUES(current_date,1)
    ON CONFLICT(day) DO UPDATE SET calls=hr_contact_search_usage.calls+1,updated_at=now()
    WHERE hr_contact_search_usage.calls<$1 RETURNING calls`,[limit])).rows.length>0;
}
export function hrContactSearch():HiringContactSearch|undefined{
  const env={...readEnv(),...process.env};
  let key=(env.BRAVE_SEARCH_API_KEY??'').trim();
  if(!key)try{key=indexConfig()?.braveKey?.trim()??'';}catch{/* HR can operate from its own configured key. */}
  if(!key)return undefined;
  return createHiringContactSearch({key,reserveSearch:()=>reserveHrContactSearch()});
}
