import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fingerprint, matchJob } from './extract.js';
import type { IndexedJob, SearchProfile } from './types.js';

export interface CrawlTask { key: string; kind: 'page'|'feed'|'search'; payload: Record<string, any>; lease: string; attempts: number }
export class JobIndexStore {
  readonly pool:pg.Pool;constructor(pool: pg.Pool) {this.pool=pool;}
  async migrate(): Promise<void> { await this.pool.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8')); }
  async enabled(): Promise<boolean> { return (await this.pool.query('SELECT enabled FROM job_index_config WHERE singleton')).rows[0]?.enabled===true; }
  async purgeInactive(ids:string[]):Promise<void> {await this.pool.query('DELETE FROM search_profiles WHERE NOT(user_id=ANY($1::bigint[]))',[ids]);}
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
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async save(job: IndexedJob): Promise<void> {
    const c=await this.pool.connect(), hash=fingerprint(job);
    try {
      await c.query('BEGIN');
      // Serialize one canonical vacancy across independent index writers. Both
      // the ID and URL have unique constraints; an upsert alone cannot arbitrate
      // two simultaneous inserts conflicting on both indexes.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8321))',[job.url]);
      await c.query(`INSERT INTO indexed_jobs(id,canonical_url,title,company,description,source,source_id,payload,payload_hash,arrangement,pay_status,posted_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,company=excluded.company,description=excluded.description,source=excluded.source,source_id=excluded.source_id,
        payload=excluded.payload,payload_hash=excluded.payload_hash,arrangement=excluded.arrangement,pay_status=excluded.pay_status,
        posted_at=excluded.posted_at,expires_at=excluded.expires_at,verified_at=now(),closed_at=NULL`,[job.id,job.url,job.title,job.company,job.description,job.source,job.sourceId,JSON.stringify(job),hash,job.workArrangement,job.pay.status,job.postedAt,job.expiresAt]);
      await c.query('INSERT INTO job_versions(job_id,payload_hash,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.id,hash,JSON.stringify(job)]);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async close(url: string): Promise<void> { await this.pool.query('UPDATE indexed_jobs SET closed_at=now() WHERE canonical_url=$1',[url]); }
  async rematch(profiles: SearchProfile[]): Promise<number> {
    let matched=0;
    // Full-text prefilter uses the database index. Only changed jobs/profiles
    // need new private match writes; do not scan every job for every customer.
    for(const p of profiles) {
      await this.pool.query(`DELETE FROM candidate_job_matches m WHERE m.user_id=$1 AND (m.profile_fingerprint<>$2 OR NOT EXISTS(SELECT 1 FROM indexed_jobs j WHERE j.id=m.job_id AND j.payload_hash=m.job_fingerprint AND j.closed_at IS NULL AND (j.expires_at IS NULL OR j.expires_at>now()) AND j.verified_at>now()-interval '14 days'))`,[p.userId,p.fingerprint]);
      const query=(p.keywords.length?p.keywords:p.skills).map(v=>v.replace(/\b(?:OR|NOT)\b|["()]/gi,' ')).join(' OR ');let after='';
      if(!query)continue;
      for(;;) {
        const rows=(await this.pool.query<{id:string;payload:IndexedJob;payload_hash:string}>(`SELECT j.id,j.payload,j.payload_hash FROM indexed_jobs j WHERE j.id>$1 AND j.closed_at IS NULL AND (j.expires_at IS NULL OR j.expires_at>now()) AND j.verified_at>now()-interval '14 days'
          AND j.search@@websearch_to_tsquery('english',$2) AND NOT EXISTS(SELECT 1 FROM candidate_job_matches m WHERE m.job_id=j.id AND m.user_id=$3 AND m.profile_fingerprint=$4 AND m.job_fingerprint=j.payload_hash) ORDER BY j.id LIMIT 300`,[after,query,p.userId,p.fingerprint])).rows;
        if(!rows.length)break;
        for(const row of rows) {
        const match=matchJob(row.payload,p);
        if(match) { await this.pool.query(`INSERT INTO candidate_job_matches(user_id,job_id,profile_fingerprint,job_fingerprint,payload) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM search_profiles WHERE user_id=$1 AND fingerprint=$3)
          ON CONFLICT(user_id,job_id) DO UPDATE SET profile_fingerprint=excluded.profile_fingerprint,job_fingerprint=excluded.job_fingerprint,payload=excluded.payload,matched_at=now()`,[p.userId,row.id,p.fingerprint,row.payload_hash,JSON.stringify(match)]);matched++; }
        else await this.pool.query('DELETE FROM candidate_job_matches WHERE user_id=$1 AND job_id=$2',[p.userId,row.id]);
        }
        after=rows.at(-1)!.id;
      }
    }
    return matched;
  }
  async enqueue(kind:CrawlTask['kind'],payload:Record<string,unknown>,priority=0):Promise<void> {
    const job=payload.job as {id?:string}|undefined;
    const identity=kind==='page'?{kind,url:payload.url}:kind==='feed'&&job?{kind,source:payload.source,target:payload.target,jobId:job.id}:{kind,payload};
    const key=fingerprint(identity);
    await this.pool.query(`INSERT INTO crawl_tasks(key,kind,payload,priority) SELECT $1,$2,$3,$4 WHERE (SELECT count(*) FROM crawl_tasks WHERE state IN ('queued','running'))<5000
      ON CONFLICT(key) DO UPDATE SET payload=CASE WHEN crawl_tasks.state='running' THEN crawl_tasks.payload ELSE excluded.payload END,priority=greatest(crawl_tasks.priority,excluded.priority)`,[key,kind,JSON.stringify(payload),priority]);
  }
  async claim():Promise<CrawlTask|null> {
    const lease=randomUUID();
    const result=await this.pool.query(`WITH next AS (SELECT key FROM crawl_tasks WHERE due_at<=now() AND (state IN ('queued','done','blocked') OR state='running' AND lease_until<now())
      ORDER BY due_at,priority DESC,key FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE crawl_tasks t SET state='running',lease=$1,lease_until=now()+interval '10 minutes',updated_at=now() FROM next WHERE t.key=next.key RETURNING t.*`,[lease]);
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
    const filters:unknown[]=[q,user,arrangement,pay,page*50];
    const result=await this.pool.query(`SELECT j.payload,j.first_seen_at,j.verified_at,${user?'m.payload':'NULL'} AS candidate_match
      FROM indexed_jobs j ${user?'JOIN candidate_job_matches m ON m.job_id=j.id AND m.user_id=$2::bigint':'LEFT JOIN candidate_job_matches m ON false'}
      WHERE j.closed_at IS NULL AND (j.expires_at IS NULL OR j.expires_at>now()) AND j.verified_at>now()-interval '14 days'
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
