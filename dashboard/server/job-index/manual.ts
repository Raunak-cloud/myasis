import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,statSync,writeFileSync,unlinkSync} from 'node:fs';
import type {JobIndexStore} from './store.js';

export type SearchProvider='brave'|'codex';
export const signalPath=(provider:SearchProvider)=>new URL(`../../../output/job-index-${provider}.pending`,import.meta.url);
export const readyPath=new URL('../../../output/job-index-codex.ready',import.meta.url);
export function codexConnected():boolean{try{return Date.now()-statSync(readyPath).mtimeMs<45_000;}catch{return false;}}
export function signal(provider:SearchProvider):void{mkdirSync(new URL('../../../output/',import.meta.url),{recursive:true});writeFileSync(signalPath(provider),'pending\n',{mode:0o600});}
export function clearSignal(provider:SearchProvider):void{try{unlinkSync(signalPath(provider));}catch{/* already claimed */}}
export function waiting(provider:SearchProvider):boolean{return existsSync(signalPath(provider));}
export class ManualSearchError extends Error{readonly status:number;constructor(message:string,status=409){super(message);this.status=status;}}
export async function requestSearch(store:JobIndexStore,actor:string,provider:unknown,connected=codexConnected(),braveConfigured=true):Promise<any>{
 if(provider!=='brave'&&provider!=='codex')throw new ManualSearchError('Choose Brave or Codex.',400);
 if(provider==='codex'&&!connected)throw new ManualSearchError('The Codex connector is offline. Open it on your signed-in computer.',503);
 if(provider==='brave'&&!braveConfigured)throw new ManualSearchError('Connect Brave in Admin → Config → Job discovery.',503);
 const c=await store.pool.connect();try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(830711,4)');
  if(!(await c.query('SELECT enabled FROM job_index_config WHERE singleton')).rows[0]?.enabled)throw new ManualSearchError('Resume the crawler before starting a search.');
  await c.query("UPDATE manual_searches SET state='failed',error='Search connection was interrupted. Start a new search when ready.',finished_at=now() WHERE state IN ('queued','searching','running') AND coalesce(lease_until,created_at+interval '2 minutes')<now()");
  const active=(await c.query("SELECT id,provider,state FROM manual_searches WHERE state IN ('queued','searching','running') LIMIT 1")).rows[0];
  if(active){await c.query('COMMIT');signal(active.provider);return {...active,existing:true};}
  if(provider==='brave'&&Number((await c.query('SELECT calls FROM search_usage WHERE day=current_date')).rows[0]?.calls??0)>=20)throw new ManualSearchError('Brave’s daily search allowance is used up. Use Codex or try again tomorrow.',429);
  const id=randomUUID();const row=(await c.query("INSERT INTO manual_searches(id,provider,actor_id) VALUES($1,$2,$3) RETURNING id,provider,state",[id,provider,actor])).rows[0];
  await c.query('INSERT INTO job_index_actions(actor_id,action) VALUES($1,$2)',[actor,`manual-${provider}-search:${id}`]);await c.query('COMMIT');signal(provider);return row;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function claimSearch(store:JobIndexStore,provider:SearchProvider):Promise<any|null>{
 if(!waiting(provider))return null;
 if(!await store.enabled())return null;
 const lease=randomUUID();
 const row=(await store.pool.query("UPDATE manual_searches SET state=$3,lease=$2,lease_until=now()+interval '15 minutes',started_at=now() WHERE id=(SELECT id FROM manual_searches WHERE provider=$1 AND state='queued' AND created_at>now()-interval '2 minutes' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",[provider,lease,provider==='codex'?'searching':'running'])).rows[0];
 clearSignal(provider);return row??null;
}
export async function finishSearch(store:JobIndexStore,job:any,stats:Record<string,unknown>,error?:string):Promise<void>{
 await store.pool.query("UPDATE manual_searches SET state=$3,stats=stats||$4::jsonb,error=$5,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease=$2 AND state IN ('searching','running')",[job.id,job.lease,error?'failed':'completed',JSON.stringify(stats),error??null]);
}
export async function searchStatus(store:JobIndexStore):Promise<unknown>{
 await store.pool.query("UPDATE manual_searches SET state='failed',error='Search connection was interrupted. Start a new search when ready.',finished_at=now() WHERE state IN ('queued','searching','running') AND coalesce(lease_until,created_at+interval '2 minutes')<now()");
 const rows=(await store.pool.query('SELECT id,provider,state,created_at,started_at,finished_at,stats,error,lease_until FROM manual_searches ORDER BY created_at DESC LIMIT 5')).rows;
 for(const r of rows)if(r.state==='queued')signal(r.provider);
 return {mode:'manual',codexConnected:codexConnected(),searches:rows.map(r=>({...r,...(['queued','searching','running'].includes(r.state)&&new Date(r.lease_until??new Date(r.created_at).getTime()+120_000).getTime()<Date.now()?{state:'failed',error:'Search connection was interrupted. Start a new search when ready.'}:{})}))};
}
