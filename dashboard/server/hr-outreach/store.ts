import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { adminAddresses } from '../admin-access.js';
import { hrOutreachAllowed, hrOutreachEligibleSql, HR_OUTREACH_ACCESS_MESSAGE } from './access.js';
import { assessHiringContact, type HiringContact, type DiscoveryResult } from './discovery.js';
import { claimDeliveryCheck, deliveryCheckAllowed, deferDeliveryCheck, completeDeliveryCheck, invalidHrAddresses, retryBouncedHrOutreach, type HrDeliveryJob } from './delivery-store.js';
import type { HrBounce } from './bounce.js';
import type { HrBrowserFailure } from '../../../seek-bot/src/hr-browser-diagnostics.js';

export interface HrDb { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }
const database: HrDb = { query: async (text, params) => ({ rows: await query(text, params) }) };
export type HrStatus = 'queued' | 'researching' | 'sending' | 'sent' | 'skipped' | 'error' | 'unconfirmed';
export type HrPhase = 'queued' | 'researching' | 'writing' | 'sending' | 'checking';
export interface HrJob {
  id: string; user_id: string; application_id: string; company_key: string; dedupe_key: string;
  job_id: string; platform: string; title: string; company: string; url: string; cover_letter: string | null;
  status: HrStatus; to_email: string | null; subject: string | null; body: string | null;
  contact: HiringContact | null; created_at: Date | string; lease: string; attempts: number; cost_usd: number;
  source_run_id?:string|null;phase?:HrPhase|null;location?:string|null;applied_at?:Date|string;
  retry_of?:string|null;outreach_attempt?:number;retry_parent_contact?:HiringContact|null;
}
export function companyKey(company: string): string {
  return company.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function outreachKey(company: string, title: string): string {
  return createHash('sha256').update(`${companyKey(company)}\n${companyKey(title)}`).digest('hex');
}
export async function getHrOutreachSettings(userId: string, db = database): Promise<{ enabled: boolean }> {
  const { rows } = await db.query('SELECT enabled FROM hr_outreach_preferences WHERE user_id=$1', [userId]);
  return { enabled: rows[0]?.enabled === true };
}
export async function setHrOutreachEnabled(userId: string, enabled: boolean, db = database): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether employer emails are enabled.');
  if (!await hrOutreachAllowed(userId, db)) throw new Error(HR_OUTREACH_ACCESS_MESSAGE);
  await db.query(`INSERT INTO hr_outreach_preferences(user_id,enabled,enabled_since) VALUES($1,$2,now())
    ON CONFLICT(user_id) DO UPDATE SET enabled=$2,
    enabled_since=CASE WHEN NOT hr_outreach_preferences.enabled AND $2 THEN now() ELSE hr_outreach_preferences.enabled_since END,
    updated_at=now()`, [userId, enabled]);
  if (!enabled) await db.query(`UPDATE hr_outreach SET status='skipped',phase=NULL,reason='HR emails were turned off.',lease=NULL,lease_until=NULL,updated_at=now()
    WHERE user_id=$1 AND status IN ('queued','researching','error')`, [userId]);
}
// A retry date is shown only while the queue can actually reclaim the item.
// Internal crawl traces and provider details are deliberately absent here.
const lookupRetryAt = `CASE WHEN (h.status='error' AND h.retry_allowed AND h.attempts<4 OR h.status='unconfirmed' AND h.attempts<8)
    AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
    AND EXISTS(SELECT 1 FROM hr_outreach_preferences p WHERE p.user_id=h.user_id AND p.enabled AND (h.status='unconfirmed' OR a.applied_at>=p.enabled_since))
    AND EXISTS(SELECT 1 FROM run_starts r WHERE r.id=a.source_run_id AND r.user_id=h.user_id AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=h.user_id AND u.blocked_at IS NULL)
    THEN h.available_at ELSE NULL END`;
const checkingDelivery = `(h.status='sent' AND h.delivery_status='unknown'
  AND h.delivery_lease IS NOT NULL AND h.delivery_lease_until>now())`;
const historyLookupFields=`h.lookup_outcome AS "lookupOutcome",h.lookup_checked_at AS "lookupCheckedAt",
  ${lookupRetryAt} AS "lookupRetryAt",${checkingDelivery} AS "checkingDelivery",
  h.contact_review_required AS "contactReviewRequired",h.contact_review_reason AS "contactReviewReason",
  h.delivery_status AS "deliveryStatus",h.delivery_reason AS "deliveryReason",h.delivery_checked_at AS "deliveryCheckedAt",h.delivery_failed_at AS "deliveryFailedAt",
  h.outreach_attempt AS "outreachAttempt",h.retry_of::text AS "retryOfId"`;
export async function listHrOutreach(userId: string, db = database) {
  const { rows } = await db.query(`SELECT h.id::text,h.job_id AS "jobId",h.platform,h.title,h.company,h.status,
    h.to_email AS "toEmail",h.subject,h.body,h.created_at AS "createdAt",h.sent_at AS "sentAt",h.reason,h.phase,a.source_run_id::text AS "sourceRunId",
    h.contact->>'sourceUrl' AS "sourceUrl",h.contact->>'name' AS "contactName",h.contact->>'sourceKind' AS "sourceKind",h.contact->>'validatedAt' AS "sourceCheckedAt",
    ${historyLookupFields}
    FROM hr_outreach h JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id WHERE h.user_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 200`, [userId]);
  return rows;
}
export async function listHrOutreachPage(userId:string, options:{cursor?:string;jobId?:string;platform?:string}={}, db=database) {
  if(options.cursor&&!/^\d{1,19}$/.test(options.cursor))throw new Error('Invalid email history page.');
  if((options.jobId&&!options.platform)||(!options.jobId&&options.platform)|| (options.jobId?.length??0)>1000 || (options.platform?.length??0)>50)throw new Error('Choose a valid application.');
  const {rows}=await db.query(`SELECT h.id::text,h.job_id AS "jobId",h.platform,h.title,h.company,h.status,
    h.to_email AS "toEmail",h.subject,h.body,h.created_at AS "createdAt",h.sent_at AS "sentAt",h.reason,h.phase,a.source_run_id::text AS "sourceRunId",
    h.contact->>'sourceUrl' AS "sourceUrl",h.contact->>'name' AS "contactName",h.contact->>'sourceKind' AS "sourceKind",h.contact->>'validatedAt' AS "sourceCheckedAt",
    ${historyLookupFields}
    FROM hr_outreach h JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id WHERE h.user_id=$1 AND ($2::bigint IS NULL OR h.id<$2)
    AND ($3::text IS NULL OR (h.job_id=$3 AND h.platform=$4)) ORDER BY h.id DESC LIMIT 51`,
  [userId,options.cursor??null,options.jobId??null,options.platform??null]);
  return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null};
}

/** The live list needs the latest roles as well as older attempts currently
 * being retried or checked. Keep recent completions long enough for a poll to
 * pick up the result. Email bodies and contact details stay in the drawer. */
export async function listHrOutreachStatuses(userId: string, db = database) {
  const active = `(h.status='queued' OR (h.status IN ('researching','sending','unconfirmed')
    AND h.lease IS NOT NULL AND h.lease_until>now()) OR ${checkingDelivery})`;
  const changed = `greatest(h.updated_at,h.delivery_checked_at,h.delivery_failed_at)`;
  const {rows} = await db.query(`WITH latest AS (
    SELECT id FROM hr_outreach WHERE user_id=$1 ORDER BY id DESC LIMIT 50
  ), recent AS (
    SELECT h.id FROM hr_outreach h WHERE h.user_id=$1 AND (${active} OR ${changed}>now()-interval '5 minutes')
    ORDER BY ${active} DESC,${changed} DESC,h.id DESC LIMIT 200
  )
  SELECT h.id::text,h.job_id AS "jobId",h.platform,h.status,h.phase,
    h.lookup_outcome AS "lookupOutcome",${lookupRetryAt} AS "lookupRetryAt",
    h.delivery_status AS "deliveryStatus",${checkingDelivery} AS "checkingDelivery"
  FROM hr_outreach h JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
  WHERE h.user_id=$1 AND h.id IN (SELECT id FROM latest UNION SELECT id FROM recent)
  ORDER BY h.id DESC`, [userId]);
  return rows;
}
export interface HrOutreachProgress {
  active:boolean;phase:HrPhase|'waiting'|'finished'|null;title:string|null;company:string|null;
  queued:number;sent:number;skipped:number;failed:number;runId:string|null;contactReviewRequiredCount?:number;deliveryFailedCount?:number;
}
export async function hrOutreachProgress(userId:string,db=database):Promise<HrOutreachProgress> {
  const {rows}=await db.query(`WITH source AS (
    SELECT coalesce((SELECT a.source_run_id FROM hr_outreach h JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      WHERE h.user_id=$1 AND ((h.lease IS NOT NULL AND h.lease_until>now() AND h.phase IN ('researching','writing','sending','checking')
      AND h.status IN ('researching','sending','unconfirmed')) OR (h.delivery_lease IS NOT NULL AND h.delivery_lease_until>now() AND h.status='sent')) ORDER BY h.id LIMIT 1),
      (SELECT max(a.source_run_id) FROM applications a JOIN hr_outreach_preferences p ON p.user_id=a.user_id
      WHERE a.user_id=$1 AND p.enabled AND a.applied_at>=p.enabled_since AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL)) AS id)
    SELECT r.id::text AS run_id,r.finished_at,r.hr_ready_at,h.status,
      CASE WHEN h.delivery_lease IS NOT NULL AND h.delivery_lease_until>now() THEN 'checking' ELSE h.phase END AS phase,h.title,h.company,h.contact_review_required,h.delivery_status,
      ((h.lease IS NOT NULL AND h.lease_until>now() AND h.status IN ('researching','sending','unconfirmed'))
        OR (h.delivery_lease IS NOT NULL AND h.delivery_lease_until>now() AND h.status='sent')) AS leased
    FROM source s JOIN run_starts r ON r.id=s.id AND r.user_id=$1
    JOIN applications a ON a.source_run_id=r.id AND a.user_id=r.user_id
    LEFT JOIN hr_outreach h ON h.application_id=a.id AND h.user_id=a.user_id
    JOIN hr_outreach_preferences p ON p.user_id=a.user_id
    WHERE a.user_id=$1 AND a.applied_at>=p.enabled_since AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL
    AND (h.id IS NOT NULL OR a.outcome IS NULL) ORDER BY h.id NULLS LAST`,[userId]);
  const result:HrOutreachProgress={active:false,phase:null,title:null,company:null,queued:0,sent:0,skipped:0,failed:0,runId:rows[0]?.run_id??null};
  if(!rows.length)return result;
  for(const row of rows){if(!row.status||row.status==='queued'||row.status==='researching'&&row.phase==='queued')result.queued++;else if(row.status==='sent')result.sent++;else if(row.status==='skipped')result.skipped++;else if(row.status==='error'||row.status==='unconfirmed'&&!(row.leased&&row.phase==='checking'))result.failed++;if(row.contact_review_required)result.contactReviewRequiredCount=(result.contactReviewRequiredCount??0)+1;if(row.delivery_status==='bounced')result.deliveryFailedCount=(result.deliveryFailedCount??0)+1;}
  const live=rows.find(row=>row.leased&&['researching','writing','sending','checking'].includes(row.phase));
  if(live){result.active=true;result.phase=live.phase;result.title=live.title;result.company=live.company;}
  else if(!rows[0].finished_at||!rows[0].hr_ready_at)result.phase='waiting';
  else result.phase=result.queued>0?'queued':'finished';
  return result;
}

export class HrStore {
  readonly db: HrDb;
  constructor(db: HrDb = database) { this.db=db; }
  claimDelivery(){return claimDeliveryCheck(this.db);}
  deliveryAllowed(job:HrDeliveryJob){return deliveryCheckAllowed(this.db,job);}
  deferDelivery(job:HrDeliveryJob){return deferDeliveryCheck(this.db,job);}
  recordDeliveryCheck(job:HrDeliveryJob,bounce:HrBounce|null,failedCheck=false){return completeDeliveryCheck(this.db,job,bounce,failedCheck);}
  invalidEmails(){return invalidHrAddresses(this.db);}
  retryBounced(userId:string,id:string){return retryBouncedHrOutreach(userId,id,this.db);}
  async enqueue(): Promise<void> {
    // No backfill: historical imports and Semi auto drafts never trigger mail.
    const { rows } = await this.db.query(`SELECT a.id::text,a.user_id::text,a.job_id,a.platform,a.title,a.company,a.url,a.cover_letter
      FROM applications a JOIN hr_outreach_preferences p ON p.user_id=a.user_id
      JOIN run_starts r ON r.id=a.source_run_id AND r.user_id=a.user_id
      JOIN users u ON u.id=a.user_id WHERE p.enabled AND u.blocked_at IS NULL
      AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL
      AND ${hrOutreachEligibleSql('$1')}
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND a.applied_at>=p.enabled_since
      AND NOT EXISTS(SELECT 1 FROM hr_outreach h WHERE h.user_id=a.user_id AND h.application_id=a.id)
      ORDER BY a.applied_at,a.id LIMIT 100`,[adminAddresses()]);
    for (const row of rows) {
      if (!row.company?.trim() || !row.title?.trim()) continue;
      await this.db.query(`INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,cover_letter)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [row.user_id,row.id,companyKey(row.company),outreachKey(row.company,row.title),row.job_id,row.platform,row.title,row.company,row.url,row.cover_letter]);
      // Remember duplicate source listings too, so they cannot starve the next
      // queue scan or cause another email for the same employer and role.
      await this.db.query(`INSERT INTO hr_outreach(user_id,application_id,company_key,dedupe_key,job_id,platform,title,company,url,status,reason)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'skipped','An HR email for this employer and role is already recorded.'
        WHERE NOT EXISTS(SELECT 1 FROM hr_outreach WHERE user_id=$1 AND application_id=$2) ON CONFLICT DO NOTHING`,
      [row.user_id,row.id,companyKey(row.company),`${outreachKey(row.company,row.title)}:duplicate:${row.id}`,row.job_id,row.platform,row.title,row.company,row.url]);
    }
  }
  async recover(): Promise<void> {
    await this.auditContacts();
    await this.db.query(`UPDATE hr_outreach SET reason='Contact research did not finish. The earlier attempt did not record a specific cause.'||
      CASE WHEN attempts>=4 THEN ' Automatic retries have finished.' ELSE '' END
      WHERE status='error' AND lookup_outcome IS NULL
      AND reason='Public contact lookup is temporarily unavailable. It will retry later.'`);
    await this.db.query(`UPDATE hr_outreach h SET status='skipped',phase=NULL,reason='HR emails were turned off for this application.',lease=NULL,lease_until=NULL,updated_at=now()
      FROM hr_outreach_preferences p,applications a WHERE h.user_id=p.user_id AND a.id=h.application_id AND a.user_id=h.user_id
      AND h.status IN ('queued','error') AND (NOT p.enabled OR a.applied_at<p.enabled_since)`);
    await this.db.query(`UPDATE hr_outreach SET status=CASE WHEN status='sending' THEN 'unconfirmed' WHEN attempts>=4 THEN 'error' ELSE 'queued' END,phase=NULL,
      reason=CASE WHEN status='sending' THEN 'Email delivery needs checking. It will not be sent again automatically.'
        WHEN attempts>=4 THEN 'HR outreach stopped before sending. Automatic retries have finished.' ELSE NULL END,
      retry_allowed=CASE WHEN status<>'sending' AND attempts>=4 THEN false ELSE retry_allowed END,
      lease=NULL,lease_until=NULL,updated_at=now() WHERE (status IN ('researching','sending') AND lease_until<now()) OR (status='queued' AND attempts>=4)`);
    await this.db.query(`UPDATE hr_outreach h SET status='skipped',phase=NULL,lease=NULL,lease_until=NULL,
      reason='HR follow-up requires a completed application run.',updated_at=now() FROM applications a
      WHERE a.id=h.application_id AND a.user_id=h.user_id AND a.source_run_id IS NULL AND h.status IN ('queued','error')`);
  }
  async claim(): Promise<HrJob | null> {
    const lease = randomUUID();
    const { rows } = await this.db.query(`WITH candidate AS (
      SELECT h.id,a.source_run_id::text AS source_run_id,a.location,a.applied_at,parent.contact AS retry_parent_contact FROM hr_outreach h JOIN hr_outreach_preferences p ON p.user_id=h.user_id
      JOIN users u ON u.id=h.user_id JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      JOIN run_starts r ON r.id=a.source_run_id AND r.user_id=a.user_id
      LEFT JOIN hr_outreach parent ON parent.id=h.retry_of AND parent.user_id=h.user_id AND parent.application_id=h.application_id
      WHERE p.enabled AND u.blocked_at IS NULL AND h.status IN ('queued','error','unconfirmed') AND h.available_at<=now()
      AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL
      AND ${hrOutreachEligibleSql('$2')}
      AND (h.lease IS NULL OR h.lease_until<now())
      AND h.attempts<CASE WHEN h.status='unconfirmed' THEN 8 ELSE 4 END
      AND (h.status<>'error' OR h.retry_allowed)
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND (h.status='unconfirmed' OR (a.applied_at>=p.enabled_since
      AND (SELECT count(*) FROM hr_outreach sent WHERE sent.user_id=h.user_id AND coalesce(sent.send_started_at,sent.sent_at)>now()-interval '24 hours')<50
      AND (SELECT coalesce(sum(cost_usd),0) FROM hr_outreach spent WHERE spent.user_id=h.user_id AND spent.updated_at>now()-interval '24 hours')<1))
      ORDER BY h.created_at,h.id FOR UPDATE OF h SKIP LOCKED LIMIT 1)
      UPDATE hr_outreach h SET status=CASE WHEN status='unconfirmed' THEN 'unconfirmed' ELSE 'researching' END,phase='queued',lease=$1,lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now()
      FROM candidate c WHERE h.id=c.id RETURNING h.*,h.id::text,h.user_id::text,h.application_id::text,h.retry_of::text,c.source_run_id,c.location,c.applied_at,c.retry_parent_contact`, [lease,adminAddresses()]);
    return rows[0] ?? null;
  }
  async allowed(job: HrJob): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT h.id FROM hr_outreach h JOIN hr_outreach_preferences p ON p.user_id=h.user_id
      JOIN users u ON u.id=h.user_id JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      JOIN run_starts r ON r.id=a.source_run_id AND r.user_id=a.user_id
      WHERE h.id=$1 AND h.user_id=$2 AND h.lease=$3 AND h.lease_until>now() AND p.enabled AND u.blocked_at IS NULL
      AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL
      AND ${hrOutreachEligibleSql('$4')}
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND (h.status='unconfirmed' OR a.applied_at>=p.enabled_since)`, [job.id,job.user_id,job.lease,adminAddresses()]);
    return rows.length > 0;
  }
  async setPhase(job:HrJob,phase:HrPhase):Promise<void> {
    await this.db.query('UPDATE hr_outreach SET phase=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND lease=$3',[job.id,job.user_id,job.lease,phase]);
  }
  async cache(key: string): Promise<{ contact: HiringContact | null; fresh: boolean; reason: string; outcome: DiscoveryResult['outcome'] | null; diagnostics: DiscoveryResult['diagnostics'] | null; contextKey?:string|null } | null> {
    const { rows } = await this.db.query("SELECT contact,(next_validation_at>now() AND validated_at+interval '1 month'>now() AND NOT EXISTS(SELECT 1 FROM hr_invalid_addresses bad WHERE bad.email=lower(trim(hr_company_contacts.contact->>'email')) AND bad.cleared_at IS NULL)) AS fresh,reason,lookup_outcome AS outcome,lookup_diagnostics AS diagnostics,lookup_context_key AS \"contextKey\" FROM hr_company_contacts WHERE company_key=$1", [key]);
    return rows[0] ?? null;
  }
  async saveContact(key: string, company: string, contact: HiringContact | null, reason: string, lookup?:DiscoveryResult, contextKey?:string): Promise<void> {
    const checkedAt=contact?new Date(contact.validatedAt):new Date();
    if(!Number.isFinite(checkedAt.getTime())||checkedAt.getTime()>Date.now()+60_000)throw Error('The public contact source has no valid check date.');
    const saved=await this.db.query(`INSERT INTO hr_company_contacts(company_key,company,contact,reason,validated_at,next_validation_at,lookup_outcome,lookup_diagnostics,contact_assessed_version,lookup_context_key)
      SELECT $1,$2,$3,$4,$7::timestamptz,$7::timestamptz+CASE WHEN $3::jsonb IS NULL THEN interval '1 day' ELSE interval '1 month' END,$5,$6,1,$8
      WHERE $3::jsonb IS NULL OR NOT EXISTS(SELECT 1 FROM hr_invalid_addresses WHERE email=lower(trim($3::jsonb->>'email')) AND cleared_at IS NULL)
      ON CONFLICT(company_key) DO UPDATE SET contact=EXCLUDED.contact,reason=EXCLUDED.reason,validated_at=EXCLUDED.validated_at,next_validation_at=EXCLUDED.next_validation_at,
      lookup_outcome=EXCLUDED.lookup_outcome,lookup_diagnostics=EXCLUDED.lookup_diagnostics,contact_assessed_version=1,lookup_context_key=EXCLUDED.lookup_context_key RETURNING company_key`,
    [key,company,contact ? JSON.stringify(contact) : null,reason,lookup?.outcome??(contact?'found':'no_contact'),lookup?.diagnostics?JSON.stringify(lookup.diagnostics):null,checkedAt.toISOString(),contextKey??null]);
    if(!saved.rows.length)throw Error('This public email address was confirmed invalid.');
  }
  async recordLookup(job:HrJob,lookup:DiscoveryResult):Promise<void> {
    await this.db.query(`UPDATE hr_outreach SET lookup_outcome=$4,lookup_checked_at=now(),lookup_diagnostics=$5,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND lease=$3`,[job.id,job.user_id,job.lease,lookup.outcome,JSON.stringify(lookup.diagnostics)]);
  }
  async researchCost(job:HrJob,cost:number):Promise<void> {
    if(!Number.isFinite(cost)||cost<0)throw Error('Invalid HR research usage.');
    const result=await this.db.query('UPDATE hr_outreach SET cost_usd=cost_usd+$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND lease=$3 AND lease_until>now() RETURNING id',[job.id,job.user_id,job.lease,cost]);
    if(!result.rows.length)throw Error('This HR research attempt is no longer active.');
  }
  async recordFailure(job:HrJob,stage:HrPhase,code:string,browserFailure?:HrBrowserFailure):Promise<void> {
    await this.db.query(`UPDATE hr_outreach SET lookup_diagnostics=coalesce(lookup_diagnostics,'{}'::jsonb)||jsonb_build_object('failureStage',$4::text,'failureCode',$5::text)||$6::jsonb,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND lease=$3`,[job.id,job.user_id,job.lease,stage,code,JSON.stringify(browserFailure?{browserFailure}:{})]);
  }
  async auditContacts():Promise<void> {
    const {rows}=await this.db.query(`SELECT id::text,company,title,contact FROM hr_outreach
      WHERE contact IS NOT NULL AND contact_assessed_version<1 ORDER BY id LIMIT 100`);
    for(const row of rows){
      const review=assessHiringContact(row.contact,row.company,row.title);
      // Audit contact quality without modifying the delivery ledger or sent content.
      await this.db.query(`UPDATE hr_outreach SET contact_review_required=$2,contact_review_reason=$3,contact_assessed_version=1
        WHERE id=$1 AND contact_assessed_version<1`,[row.id,review.reviewRequired,review.reason]);
    }
    const cached=await this.db.query('SELECT company_key,company,contact FROM hr_company_contacts WHERE contact IS NOT NULL AND contact_assessed_version<1 LIMIT 100');
    for(const row of cached.rows){if(assessHiringContact(row.contact,row.company).reviewRequired)
      await this.db.query('DELETE FROM hr_company_contacts WHERE company_key=$1 AND contact=$2::jsonb',[row.company_key,JSON.stringify(row.contact)]);
      else await this.db.query('UPDATE hr_company_contacts SET contact_assessed_version=1 WHERE company_key=$1 AND contact=$2::jsonb',[row.company_key,JSON.stringify(row.contact)]);}
  }
  async staleContact(): Promise<{company_key:string;company:string;contact:HiringContact} | null> {
    const { rows } = await this.db.query(`SELECT company_key,company,contact FROM hr_company_contacts WHERE contact IS NOT NULL
      AND next_validation_at<=now() ORDER BY next_validation_at LIMIT 1`);
    return rows[0] ?? null;
  }
  async deferValidation(key:string):Promise<void> {
    // Scheduling a retry never renews publication validity.
    await this.db.query("UPDATE hr_company_contacts SET next_validation_at=now()+interval '30 minutes' WHERE company_key=$1",[key]);
  }
  async draft(job: HrJob, contact: HiringContact, subject: string, body: string, cost: number): Promise<void> {
    await this.db.query(`UPDATE hr_outreach SET contact=$4,to_email=$5,subject=$6,body=$7,cost_usd=cost_usd+$8,contact_assessed_version=1,contact_review_required=false,contact_review_reason=NULL,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND (lease=$3 OR status='skipped')`, [job.id,job.user_id,job.lease,JSON.stringify(contact),contact.email,subject,body,cost]);
  }
  async sending(job: HrJob): Promise<boolean> {
    const { rows } = await this.db.query(`UPDATE hr_outreach h SET status='sending',phase='sending',reason=NULL,send_started_at=now(),updated_at=now()
      FROM hr_outreach_preferences p,applications a,users u,run_starts r
      WHERE h.id=$1 AND h.user_id=$2 AND h.lease=$3 AND h.status='researching' AND h.lease_until>now()
      AND p.user_id=h.user_id AND p.enabled AND u.id=h.user_id AND u.blocked_at IS NULL
      AND ${hrOutreachEligibleSql('$4')}
      AND a.id=h.application_id AND a.user_id=h.user_id AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND r.id=a.source_run_id AND r.user_id=a.user_id AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL
      AND a.applied_at>=p.enabled_since
      AND NOT EXISTS(SELECT 1 FROM hr_invalid_addresses bad WHERE bad.email=lower(trim(h.to_email)) AND bad.cleared_at IS NULL)
      RETURNING h.id`, [job.id,job.user_id,job.lease,adminAddresses()]);
    return rows.length > 0;
  }
  async finish(job: HrJob, status: HrStatus, reason: string | null, receipt?: {messageId:string;threadId?:string}, extraCost = 0, options:{retryable?:boolean}={}): Promise<void> {
    if(status==='error'&&job.attempts>=4&&options.retryable!==false)reason=`${reason??'HR outreach could not finish.'} Automatic retries have finished.`;
    await this.db.query(`UPDATE hr_outreach SET status=$4,phase=NULL,reason=$5,message_id=coalesce($6,message_id),thread_id=coalesce($7,thread_id),
      sent_at=CASE WHEN $4='sent' THEN coalesce(sent_at,now()) ELSE sent_at END,cost_usd=cost_usd+$8,
      delivery_check_after=CASE WHEN $4='sent' THEN now() ELSE delivery_check_after END,
      lease=NULL,lease_until=NULL,available_at=now()+interval '30 minutes',retry_allowed=$9,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND lease=$3`, [job.id,job.user_id,job.lease,status,reason,receipt?.messageId??null,receipt?.threadId??null,extraCost,options.retryable!==false]);
  }
  async defer(job: HrJob): Promise<void> {
    await this.db.query(`UPDATE hr_outreach SET status=CASE WHEN status='unconfirmed' THEN 'unconfirmed' ELSE 'queued' END,phase='queued',attempts=greatest(0,attempts-1),available_at=now()+interval '30 seconds',lease=NULL,lease_until=NULL WHERE id=$1 AND user_id=$2 AND lease=$3`, [job.id,job.user_id,job.lease]);
  }
}
