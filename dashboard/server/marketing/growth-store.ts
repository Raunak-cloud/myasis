import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { MarketingError, ownedSite, siteView, topicView, transaction } from './store.js';
import { contentStrategy, fingerprint, normalizeObservation, visibilityPrompts } from './growth.js';
import { reportingConnection } from './google-results.js';
import type { AIObservation, ContentAction, MarketingGrowth, MarketingSite, ResultsSnapshot } from '../../src/marketingTypes.js';

export async function growthWorkspace(userId:string,siteId:string,site?:MarketingSite):Promise<MarketingGrowth> {
  const current=site || siteView(await ownedSite(userId,siteId));
  const [topics,states,observations,results,connection]=await Promise.all([
    query('SELECT * FROM marketing_topics WHERE site_id=$1 AND user_id=$2 ORDER BY created_at,id',[siteId,userId]),
    query<{action_id:string;status:ContentAction['status']}>('SELECT action_id,status FROM marketing_action_states WHERE site_id=$1 AND user_id=$2',[siteId,userId]),
    query<{observation:AIObservation}>('SELECT observation FROM marketing_ai_observations WHERE site_id=$1 AND user_id=$2 ORDER BY observed_at DESC,created_at DESC LIMIT 100',[siteId,userId]),
    query<{snapshot:ResultsSnapshot}>('SELECT snapshot FROM marketing_result_snapshots WHERE site_id=$1 AND user_id=$2 ORDER BY period_end DESC,created_at DESC LIMIT 100',[siteId,userId]),
    reportingConnection(userId,siteId),
  ]);
  const snapshots=results.map(r=>r.snapshot);
  return {strategy:contentStrategy(current,topics.map(topicView),new Map(states.map(s=>[s.action_id,s.status])),snapshots),observations:observations.map(r=>r.observation),results:snapshots,prompts:visibilityPrompts(current),connection};
}
export async function updateAction(userId:string,siteId:string,id:string,status:unknown) {
  if(!['open','done','dismissed'].includes(String(status))) throw new MarketingError('Choose a valid action status.');
  const data=await growthWorkspace(userId,siteId);if(!data.strategy.actions.some(a=>a.id===id)) throw new MarketingError('Action not found. Refresh the strategy.',404);
  await query('INSERT INTO marketing_action_states(site_id,user_id,action_id,status) VALUES($1,$2,$3,$4) ON CONFLICT(site_id,action_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()',[siteId,userId,id,status]);
}
export async function saveObservation(userId:string,siteId:string,value:Record<string,unknown>,method:AIObservation['method']='recorded') {
  const site=siteView(await ownedSite(userId,siteId));let observation:AIObservation;
  try {observation=normalizeObservation(value,site,method);} catch(e) {throw new MarketingError((e as Error).message);}
  const rows=await query('INSERT INTO marketing_ai_observations(id,site_id,user_id,observation,fingerprint,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(site_id,fingerprint) DO NOTHING RETURNING id',[observation.id,siteId,userId,observation,observation.fingerprint,observation.observedAt]);
  return {id:rows[0]?.id || (await one('SELECT id FROM marketing_ai_observations WHERE site_id=$1 AND fingerprint=$2',[siteId,observation.fingerprint]))?.id};
}
export async function confirmRecommendation(userId:string,siteId:string,id:string,quote:unknown) {
  const site=siteView(await ownedSite(userId,siteId));const row=await one('SELECT observation FROM marketing_ai_observations WHERE id=$1 AND site_id=$2 AND user_id=$3',[id,siteId,userId]);
  if(!row || row.observation.status!=='complete') throw new MarketingError('Completed observation not found.',404);
  if(typeof quote!=='string') throw new MarketingError('Enter an exact recommendation quote or leave it blank.');
  let updated:AIObservation;try {updated=normalizeObservation({...row.observation,recommendationQuote:quote},site,row.observation.method);} catch(e) {throw new MarketingError((e as Error).message);}
  updated.id=id;await query('UPDATE marketing_ai_observations SET observation=$4,fingerprint=$5 WHERE id=$1 AND site_id=$2 AND user_id=$3',[id,siteId,userId,updated,updated.fingerprint]);
}
export async function saveResultsSnapshot(userId:string,siteId:string,snapshot:ResultsSnapshot) {
  await ownedSite(userId,siteId);
  const {id:_id,recordedAt:_recorded,...values}=snapshot;
  const key=fingerprint(values);
  await query('INSERT INTO marketing_result_snapshots(id,site_id,user_id,source,period_start,period_end,snapshot,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(site_id,fingerprint) DO NOTHING',[snapshot.id,siteId,userId,snapshot.source,snapshot.periodStart,snapshot.periodEnd,snapshot,key]);
}
export async function queueVisibility(userId:string,siteId:string,body:Record<string,unknown>) {
  await ownedSite(userId,siteId);
  if(!['ChatGPT','Perplexity'].includes(String(body.provider)) || !Array.isArray(body.prompts) || body.prompts.length<1 || body.prompts.length>3 || body.prompts.some(p=>typeof p!=='string' || p.trim().length<10 || p.length>500)) throw new MarketingError('Choose ChatGPT or Perplexity and one to three prompts of 10–500 characters.');
  const prompts=body.prompts.map(p=>(p as string).trim());
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[userId]);
    await client.query('SELECT id FROM marketing_sites WHERE id=$1 AND user_id=$2 FOR UPDATE',[siteId,userId]);
    if((await client.query("SELECT 1 FROM marketing_jobs WHERE site_id=$1 AND status IN ('queued','running')",[siteId])).rowCount) throw new MarketingError('This website already has work in progress.',409);
    const count=(await client.query("SELECT count(*)::int n FROM marketing_jobs WHERE user_id=$1 AND kind='visibility' AND created_at>now()-interval '24 hours'",[userId])).rows[0];
    if(count.n>=10) throw new MarketingError('Daily browser AI check limit reached. You can still record an answer manually.',429);
    const id=randomUUID();
    await client.query("INSERT INTO marketing_jobs(id,site_id,user_id,kind,payload,idempotency_key) VALUES($1,$2,$3,'visibility',$4,$1::text)",[id,siteId,userId,{provider:body.provider,prompts}]);
    return {id};
  });
}
