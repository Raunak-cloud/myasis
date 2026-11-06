import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fingerprint, matchJob } from './extract.js';
import {AUSTRALIA_POLICY,australianEligibility} from './geography.js';
import {MATCH_POLICY,FIT_CACHE_POLICY,type IndexedJob,type SearchProfile,type MatchResult} from './types.js';

export interface CrawlTask { key: string; kind: 'page'|'feed'|'search'; payload: Record<string, any>; lease: string; attempts: number }
export class JobIndexStore {
  readonly pool:pg.Pool;constructor(pool: pg.Pool) {this.pool=pool;}
  async migrate(): Promise<void> {
    const c=await this.pool.connect();try{
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(830711,3)');
      await c.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
      // Quarantine is enforced in reads too. Validate legacy catalog facts with
      // the very same policy as new writes; never promote an AI score alone.
      await c.query('LOCK TABLE indexed_jobs IN SHARE ROW EXCLUSIVE MODE');
      for(;;){
        const rows=(await c.query<{id:string;payload:IndexedJob}>('SELECT id,payload FROM indexed_jobs WHERE country_policy IS DISTINCT FROM $1 LIMIT 500',[AUSTRALIA_POLICY])).rows;
        if(!rows.length)break;
        const eligible=rows.filter(r=>australianEligibility(r.payload).status==='eligible').map(r=>r.id);
        const rejected=rows.filter(r=>!eligible.includes(r.id)).map(r=>r.id);
        if(eligible.length)await c.query('UPDATE indexed_jobs SET country_policy=$1 WHERE id=ANY($2::text[])',[AUSTRALIA_POLICY,eligible]);
        if(rejected.length)await c.query('DELETE FROM indexed_jobs WHERE id=ANY($1::text[])',[rejected]);
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async enabled(): Promise<boolean> { return (await this.pool.query('SELECT enabled FROM job_index_config WHERE singleton')).rows[0]?.enabled===true; }
  async purgeInactive(ids:string[]):Promise<void> {const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('DELETE FROM search_profiles WHERE NOT(user_id=ANY($1::bigint[]))',[ids]);await this.prune(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  async cachedProfiles():Promise<SearchProfile[]> {return (await this.pool.query<{payload:SearchProfile}>('SELECT payload FROM search_profiles')).rows.map(r=>r.payload);}
  async profiles(profiles: SearchProfile[]): Promise<void> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Removing a deleted, blocked or no-longer-paid account cascades its private matches.
      await c.query('DELETE FROM search_profiles WHERE NOT(user_id=ANY($1::bigint[]))',[profiles.map(p=>p.userId)]);
      for(const p of profiles) {
        await c.query('DELETE FROM candidate_job_matches WHERE user_id=$1 AND profile_fingerprint<>$2',[p.userId,p.fingerprint]);
        await c.query(`INSERT INTO search_profiles(user_id,fingerprint,payload) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,updated_at=now()`,[p.userId,p.fingerprint,JSON.stringify(p)]);
      }
      await this.prune(c);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async save(job: IndexedJob,approvals:Array<{profile:SearchProfile;match:MatchResult}>): Promise<boolean> {
    if(australianEligibility(job).status!=='eligible')return false;
    if(!approvals.length)return false;
    if(approvals.some(a=>a.match.status!=='matched'||a.match.review?.policy!==MATCH_POLICY||!Number.isFinite(a.match.review.score)||a.match.review.score<(a.profile.criteria?.minScore??60)||!matchJob(job,a.profile)))throw Error('Only reviewed matching jobs can enter the catalog.');
    const c=await this.pool.connect(), hash=fingerprint(job);
    try {
      await c.query('BEGIN');
      const owners=(await c.query<{user_id:string;fingerprint:string}>('SELECT user_id::text,fingerprint FROM search_profiles WHERE user_id=ANY($1::bigint[]) FOR SHARE',[approvals.map(a=>a.profile.userId)])).rows;
      approvals=approvals.filter(a=>owners.some(o=>o.user_id===a.profile.userId&&o.fingerprint===a.profile.fingerprint));
      if(!approvals.length){await c.query('ROLLBACK');return false;}
      // Serialize one canonical vacancy across independent index writers. Both
      // the ID and URL have unique constraints; an upsert alone cannot arbitrate
      // two simultaneous inserts conflicting on both indexes.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8321))',[job.url]);
      await c.query(`INSERT INTO indexed_jobs(id,canonical_url,title,company,description,source,source_id,payload,payload_hash,arrangement,pay_status,posted_at,expires_at,country_policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,company=excluded.company,description=excluded.description,source=excluded.source,source_id=excluded.source_id,
        payload=excluded.payload,payload_hash=excluded.payload_hash,arrangement=excluded.arrangement,pay_status=excluded.pay_status,
        posted_at=excluded.posted_at,expires_at=excluded.expires_at,country_policy=excluded.country_policy,verified_at=now(),closed_at=NULL`,[job.id,job.url,job.title,job.company,job.description,job.source,job.sourceId,JSON.stringify(job),hash,job.workArrangement,job.pay.status,job.postedAt,job.expiresAt,AUSTRALIA_POLICY]);
      await c.query('INSERT INTO job_versions(job_id,payload_hash,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.id,hash,JSON.stringify(job)]);
      await c.query('DELETE FROM candidate_job_matches WHERE job_id=$1 AND job_fingerprint<>$2',[job.id,hash]);
      for(const a of approvals)await c.query(`INSERT INTO candidate_job_matches(user_id,job_id,profile_fingerprint,job_fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,job_id) DO UPDATE SET profile_fingerprint=excluded.profile_fingerprint,job_fingerprint=excluded.job_fingerprint,payload=excluded.payload,matched_at=now()`,[a.profile.userId,job.id,a.profile.fingerprint,hash,JSON.stringify(a.match)]);
      await c.query('COMMIT');return true;
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async close(url: string): Promise<void> { await this.pool.query('UPDATE indexed_jobs SET closed_at=now() WHERE canonical_url=$1',[url]); }
  private async prune(c:pg.PoolClient):Promise<void> {
    await c.query('DELETE FROM indexed_jobs WHERE country_policy IS DISTINCT FROM $1',[AUSTRALIA_POLICY]);
    await c.query(`DELETE FROM candidate_job_matches m WHERE NOT EXISTS(SELECT 1 FROM search_profiles p JOIN indexed_jobs j ON j.id=m.job_id WHERE p.user_id=m.user_id AND p.fingerprint=m.profile_fingerprint AND j.closed_at IS NULL AND (j.expires_at IS NULL OR j.expires_at>now()) AND (j.posted_at IS NULL OR coalesce((p.payload#>>'{criteria,maxAgeDays}')::float8,0)=0 OR j.posted_at>=now()-coalesce((p.payload#>>'{criteria,maxAgeDays}')::float8,0)*interval '1 day'))`);
    await c.query(`DELETE FROM indexed_jobs j WHERE NOT EXISTS(SELECT 1 FROM candidate_job_matches m WHERE m.job_id=j.id AND m.job_fingerprint=j.payload_hash AND m.payload#>>'{review,policy}'=$1)`,[MATCH_POLICY]);
    await c.query('DELETE FROM fit_decisions WHERE expires_at<now()');
  }
  async cachedDecision(p:SearchProfile,job:IndexedJob):Promise<MatchResult|null|'uncertain'|undefined> {
    const rows=(await this.pool.query('SELECT decision,match FROM fit_decisions WHERE user_id=$1 AND profile_fingerprint=$2 AND job_fingerprint=$3 AND policy=$4 AND expires_at>now()',[p.userId,p.fingerprint,fingerprint(job),FIT_CACHE_POLICY])).rows;
    return !rows.length?undefined:rows[0].decision==='match'?rows[0].match:rows[0].decision==='uncertain'?'uncertain':null;
  }
  async cacheDecision(p:SearchProfile,job:IndexedJob,match:MatchResult|null,uncertain=false):Promise<void> {
    await this.pool.query(`INSERT INTO fit_decisions(user_id,profile_fingerprint,job_fingerprint,policy,decision,match,expires_at) SELECT $1,$2,$3,$4,$5,$6,now()+$7*interval '1 hour' WHERE EXISTS(SELECT 1 FROM search_profiles WHERE user_id=$1 AND fingerprint=$2)
      ON CONFLICT(user_id,profile_fingerprint,job_fingerprint,policy) DO UPDATE SET decision=excluded.decision,match=excluded.match,expires_at=excluded.expires_at`,[p.userId,p.fingerprint,fingerprint(job),FIT_CACHE_POLICY,match?'match':uncertain?'uncertain':'no_match',match?JSON.stringify(match):null,uncertain?1:168]);
  }
  async invalidate(job:IndexedJob):Promise<void>{
    // A changed public description cannot retain approvals of its old content.
    await this.pool.query('DELETE FROM indexed_jobs WHERE id=$1 AND payload_hash<>$2',[job.id,fingerprint(job)]);
  }
  async reserveReview(reserved:number):Promise<string|null>{
    if(!Number.isFinite(reserved)||reserved<=0||reserved>1)return null;
    const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(830711,2)');
      const used=(await c.query("SELECT count(*)::int AS calls,coalesce(sum(greatest(reserved_usd,coalesce(amount_usd,0))),0)::float8 AS amount FROM fit_review_requests WHERE created_at>=date_trunc('day',now())")).rows[0];
      if(used.calls>=100||used.amount+reserved>1){await c.query('ROLLBACK');return null;}
      const id=randomUUID();await c.query('INSERT INTO fit_review_requests(id,reserved_usd) VALUES($1,$2)',[id,reserved]);await c.query('COMMIT');return id;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async completeReview(id:string,amount:number|null,basis:string,status:string):Promise<void>{await this.pool.query('UPDATE fit_review_requests SET amount_usd=$2,basis=$3,status=$4 WHERE id=$1',[id,amount,basis,status]);}
  async enqueue(kind:CrawlTask['kind'],payload:Record<string,unknown>,priority=0):Promise<void> {
    const job=payload.job as {id?:string;url?:string;platform?:string;source?:string}|undefined;
    if(job)payload={...payload,job:{id:job.id,url:job.url,platform:job.platform,source:job.source}};
    const identity=kind==='page'?{kind,url:payload.url}:kind==='feed'&&job?{kind,source:payload.source,target:payload.target,jobId:job.id}:{kind,payload};
    const key=fingerprint(identity);
    await this.pool.query(`INSERT INTO crawl_tasks(key,kind,payload,priority) SELECT $1,$2,$3,$4 WHERE (SELECT count(*) FROM crawl_tasks WHERE state IN ('queued','running'))<5000
      ON CONFLICT(key) DO UPDATE SET payload=CASE WHEN crawl_tasks.state='running' THEN crawl_tasks.payload ELSE excluded.payload END,priority=greatest(crawl_tasks.priority,excluded.priority)`,[key,kind,JSON.stringify(payload),priority]);
  }
  async claim(lane?:{kind:CrawlTask['kind'];source?:string}):Promise<CrawlTask|null> {
    const lease=randomUUID();
    const result=await this.pool.query(`WITH next AS (SELECT key FROM crawl_tasks WHERE due_at<=now() AND (state IN ('queued','done','blocked') OR state='running' AND lease_until<now())
      AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR payload->>'source'=$3)
      ORDER BY priority DESC,due_at,key FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE crawl_tasks t SET state='running',lease=$1,lease_until=now()+interval '10 minutes',updated_at=now() FROM next WHERE t.key=next.key RETURNING t.*`,[lease,lane?.kind??null,lane?.source??null]);
    return result.rows[0]??null;
  }
  async reserveSearch():Promise<boolean> {
    return !!(await this.pool.query(`INSERT INTO search_usage(day,calls) VALUES(current_date,1) ON CONFLICT(day) DO UPDATE SET calls=search_usage.calls+1 WHERE search_usage.calls<20 RETURNING calls`)).rows.length;
  }
  async finish(t:CrawlTask,status:'done'|'blocked'|'failed'|'deferred',reason:string|null=null,waitMs=6*3600_000):Promise<void> {
    const attempts=status==='failed'?t.attempts+1:0;
    const state=status==='deferred'?'queued':status==='failed'&&attempts<3?'queued':status;
    const delay=status==='failed'?Math.min(24*3600_000,60_000*2**attempts):waitMs;
    await this.pool.query(`UPDATE crawl_tasks SET state=$3,attempts=$4,last_error=$5,due_at=now()+$6*interval '1 millisecond',lease=NULL,lease_until=NULL,updated_at=now() WHERE key=$1 AND lease=$2`,[t.key,t.lease,state,attempts,reason?.slice(0,400)??null,delay]);
  }
  async search(params:URLSearchParams):Promise<unknown> {
    const user=params.get('user');if(user&&!/^\d+$/.test(user))throw Error('Choose a valid account.');
    const arrangement=params.get('arrangement'),pay=params.get('pay'),q=(params.get('q')??'').slice(0,150);
    const page=Math.max(0,Math.min(10_000,Math.floor(Number(params.get('page'))||0)));
    const filters:unknown[]=[q,user,arrangement,pay,page*50,AUSTRALIA_POLICY,MATCH_POLICY];
    const result=await this.pool.query(`SELECT j.payload,j.first_seen_at,j.verified_at,j.payload_hash,
      coalesce((SELECT jsonb_agg(jsonb_build_object('userId',cm.user_id::text,'matchedAt',cm.matched_at,'match',cm.payload) ORDER BY cm.user_id)
        FROM candidate_job_matches cm JOIN search_profiles owner ON owner.user_id=cm.user_id AND owner.fingerprint=cm.profile_fingerprint
        WHERE cm.job_id=j.id AND cm.job_fingerprint=j.payload_hash), '[]'::jsonb) AS matches,
      ${user?'m.payload':'NULL'} AS candidate_match
      FROM indexed_jobs j ${user?'JOIN candidate_job_matches m ON m.job_id=j.id AND m.user_id=$2::bigint':'LEFT JOIN candidate_job_matches m ON false'}
      WHERE j.country_policy=$6 AND EXISTS(SELECT 1 FROM candidate_job_matches approved WHERE approved.job_id=j.id AND approved.job_fingerprint=j.payload_hash AND approved.payload#>>'{review,policy}'=$7) AND j.closed_at IS NULL AND (j.expires_at IS NULL OR j.expires_at>now()) AND j.verified_at>now()-interval '14 days'
       AND ($1='' OR j.search@@websearch_to_tsquery('english',$1)) AND ($3::text IS NULL OR j.arrangement=$3) AND ($4::text IS NULL OR j.pay_status=$4)
       AND ($2::text IS NULL OR m.user_id=$2::bigint) ORDER BY j.verified_at DESC,j.id LIMIT 51 OFFSET $5`,filters);
    return {jobs:result.rows.slice(0,50),hasMore:result.rows.length>50,page};
  }
  async status():Promise<unknown> {
    return {enabled:await this.enabled(),counts:(await this.pool.query(`SELECT count(*)::int AS jobs,count(*) FILTER(WHERE closed_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND verified_at>now()-interval '14 days')::int AS fresh_jobs FROM indexed_jobs`)).rows[0],
      profiles:Number((await this.pool.query('SELECT count(*) FROM search_profiles')).rows[0].count),tasks:(await this.pool.query('SELECT state,count(*)::int AS count FROM crawl_tasks GROUP BY state')).rows,
      cycles:(await this.pool.query('SELECT * FROM crawl_cycles ORDER BY started_at DESC LIMIT 5')).rows,
      issues:(await this.pool.query("SELECT kind,payload->>'source' AS source,payload->>'url' AS url,last_error,state,updated_at FROM crawl_tasks WHERE state IN ('blocked','failed') ORDER BY updated_at DESC LIMIT 15")).rows};
  }
  async setEnabled(actorId:string,enabled:boolean):Promise<void> {
    const c=await this.pool.connect();try {await c.query('BEGIN');await c.query('UPDATE job_index_config SET enabled=$1 WHERE singleton',[enabled]);await c.query('INSERT INTO job_index_actions(actor_id,action) VALUES($1,$2)',[actorId,enabled?'resumed':'paused']);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
}
