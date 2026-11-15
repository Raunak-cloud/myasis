import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import type { HiringContact } from './discovery.js';

export interface HrDb { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }
const database: HrDb = { query: async (text, params) => ({ rows: await query(text, params) }) };
export type HrStatus = 'queued' | 'researching' | 'sending' | 'sent' | 'skipped' | 'error' | 'unconfirmed';
export interface HrJob {
  id: string; user_id: string; application_id: string; company_key: string; dedupe_key: string;
  job_id: string; platform: string; title: string; company: string; url: string; cover_letter: string | null;
  status: HrStatus; to_email: string | null; subject: string | null; body: string | null;
  contact: HiringContact | null; created_at: Date | string; lease: string; attempts: number; cost_usd: number;
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
  if (typeof enabled !== 'boolean') throw new Error('Choose whether HR emails are enabled.');
  await db.query(`INSERT INTO hr_outreach_preferences(user_id,enabled,enabled_since) VALUES($1,$2,now())
    ON CONFLICT(user_id) DO UPDATE SET enabled=$2,
    enabled_since=CASE WHEN NOT hr_outreach_preferences.enabled AND $2 THEN now() ELSE hr_outreach_preferences.enabled_since END,
    updated_at=now()`, [userId, enabled]);
  if (!enabled) await db.query(`UPDATE hr_outreach SET status='skipped',reason='HR emails were turned off.',lease=NULL,updated_at=now()
    WHERE user_id=$1 AND status IN ('queued','researching','error')`, [userId]);
}
export async function listHrOutreach(userId: string, db = database) {
  const { rows } = await db.query(`SELECT h.id::text,h.job_id AS "jobId",h.platform,h.title,h.company,h.status,
    h.to_email AS "toEmail",h.subject,h.body,h.created_at AS "createdAt",h.sent_at AS "sentAt",h.reason,
    h.contact->>'sourceUrl' AS "sourceUrl",h.contact->>'name' AS "contactName"
    FROM hr_outreach h WHERE h.user_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 200`, [userId]);
  return rows;
}
export async function listHrOutreachPage(userId:string, options:{cursor?:string;jobId?:string;platform?:string}={}, db=database) {
  if(options.cursor&&!/^\d{1,19}$/.test(options.cursor))throw new Error('Invalid email history page.');
  if((options.jobId&&!options.platform)||(!options.jobId&&options.platform)|| (options.jobId?.length??0)>1000 || (options.platform?.length??0)>50)throw new Error('Choose a valid application.');
  const {rows}=await db.query(`SELECT h.id::text,h.job_id AS "jobId",h.platform,h.title,h.company,h.status,
    h.to_email AS "toEmail",h.subject,h.body,h.created_at AS "createdAt",h.sent_at AS "sentAt",h.reason,
    h.contact->>'sourceUrl' AS "sourceUrl",h.contact->>'name' AS "contactName"
    FROM hr_outreach h WHERE h.user_id=$1 AND ($2::bigint IS NULL OR h.id<$2)
    AND ($3::text IS NULL OR (h.job_id=$3 AND h.platform=$4)) ORDER BY h.id DESC LIMIT 51`,
  [userId,options.cursor??null,options.jobId??null,options.platform??null]);
  return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null};
}

export class HrStore {
  readonly db: HrDb;
  constructor(db: HrDb = database) { this.db=db; }
  async enqueue(): Promise<void> {
    // No backfill: historical imports and Semi auto drafts never trigger mail.
    const { rows } = await this.db.query(`SELECT a.id::text,a.user_id::text,a.job_id,a.platform,a.title,a.company,a.url,a.cover_letter
      FROM applications a JOIN hr_outreach_preferences p ON p.user_id=a.user_id
      JOIN users u ON u.id=a.user_id WHERE p.enabled AND u.blocked_at IS NULL
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND a.applied_at>=p.enabled_since
      AND NOT EXISTS(SELECT 1 FROM hr_outreach h WHERE h.user_id=a.user_id AND h.application_id=a.id)
      ORDER BY a.applied_at,a.id LIMIT 100`);
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
    await this.db.query(`UPDATE hr_outreach h SET status='skipped',reason='HR emails were turned off for this application.',lease=NULL,lease_until=NULL,updated_at=now()
      FROM hr_outreach_preferences p,applications a WHERE h.user_id=p.user_id AND a.id=h.application_id AND a.user_id=h.user_id
      AND h.status IN ('queued','error') AND (NOT p.enabled OR a.applied_at<p.enabled_since)`);
    await this.db.query(`UPDATE hr_outreach SET status=CASE WHEN status='sending' THEN 'unconfirmed' ELSE 'queued' END,
      reason=CASE WHEN status='sending' THEN 'Email delivery needs checking. It will not be sent again automatically.' ELSE NULL END,
      lease=NULL,lease_until=NULL,updated_at=now() WHERE status IN ('researching','sending') AND lease_until<now()`);
  }
  async claim(): Promise<HrJob | null> {
    const lease = randomUUID();
    const { rows } = await this.db.query(`WITH candidate AS (
      SELECT h.id FROM hr_outreach h JOIN hr_outreach_preferences p ON p.user_id=h.user_id
      JOIN users u ON u.id=h.user_id JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      WHERE p.enabled AND u.blocked_at IS NULL AND h.status IN ('queued','error','unconfirmed') AND h.available_at<=now()
      AND (h.lease IS NULL OR h.lease_until<now())
      AND h.attempts<CASE WHEN h.status='unconfirmed' THEN 8 ELSE 4 END
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND (h.status='unconfirmed' OR (a.applied_at>=p.enabled_since
      AND (SELECT count(*) FROM hr_outreach sent WHERE sent.user_id=h.user_id AND coalesce(sent.send_started_at,sent.sent_at)>now()-interval '24 hours')<50
      AND (SELECT coalesce(sum(cost_usd),0) FROM hr_outreach spent WHERE spent.user_id=h.user_id AND spent.updated_at>now()-interval '24 hours')<1))
      ORDER BY h.created_at,h.id FOR UPDATE OF h SKIP LOCKED LIMIT 1)
      UPDATE hr_outreach h SET status=CASE WHEN status='unconfirmed' THEN 'unconfirmed' ELSE 'researching' END,lease=$1,lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now()
      FROM candidate c WHERE h.id=c.id RETURNING h.*,h.id::text,h.user_id::text,h.application_id::text`, [lease]);
    return rows[0] ?? null;
  }
  async allowed(job: HrJob): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT h.id FROM hr_outreach h JOIN hr_outreach_preferences p ON p.user_id=h.user_id
      JOIN users u ON u.id=h.user_id JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      WHERE h.id=$1 AND h.user_id=$2 AND h.lease=$3 AND h.lease_until>now() AND p.enabled AND u.blocked_at IS NULL
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND (h.status='unconfirmed' OR a.applied_at>=p.enabled_since)`, [job.id,job.user_id,job.lease]);
    return rows.length > 0;
  }
  async cache(key: string): Promise<{ contact: HiringContact | null; fresh: boolean; reason: string } | null> {
    const { rows } = await this.db.query("SELECT contact,(next_validation_at>now() AND validated_at+interval '1 month'>now()) AS fresh,reason FROM hr_company_contacts WHERE company_key=$1", [key]);
    return rows[0] ?? null;
  }
  async saveContact(key: string, company: string, contact: HiringContact | null, reason: string): Promise<void> {
    await this.db.query(`INSERT INTO hr_company_contacts(company_key,company,contact,reason,validated_at,next_validation_at)
      VALUES($1,$2,$3,$4,now(),now()+CASE WHEN $3::jsonb IS NULL THEN interval '1 day' ELSE interval '1 month' END)
      ON CONFLICT(company_key) DO UPDATE SET contact=EXCLUDED.contact,reason=EXCLUDED.reason,validated_at=now(),next_validation_at=EXCLUDED.next_validation_at`,
    [key,company,contact ? JSON.stringify(contact) : null,reason]);
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
    await this.db.query(`UPDATE hr_outreach SET contact=$4,to_email=$5,subject=$6,body=$7,cost_usd=cost_usd+$8,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND (lease=$3 OR status='skipped')`, [job.id,job.user_id,job.lease,JSON.stringify(contact),contact.email,subject,body,cost]);
  }
  async sending(job: HrJob): Promise<boolean> {
    const { rows } = await this.db.query(`UPDATE hr_outreach h SET status='sending',reason=NULL,send_started_at=now(),updated_at=now()
      FROM hr_outreach_preferences p,applications a,users u
      WHERE h.id=$1 AND h.user_id=$2 AND h.lease=$3 AND h.status='researching' AND h.lease_until>now()
      AND p.user_id=h.user_id AND p.enabled AND u.id=h.user_id AND u.blocked_at IS NULL
      AND a.id=h.application_id AND a.user_id=h.user_id AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND a.applied_at>=p.enabled_since
      RETURNING h.id`, [job.id,job.user_id,job.lease]);
    return rows.length > 0;
  }
  async finish(job: HrJob, status: HrStatus, reason: string | null, receipt?: {messageId:string;threadId?:string}, extraCost = 0): Promise<void> {
    if(status==='error'&&job.attempts>=4&&reason?.includes('retry later'))reason='HR outreach needs attention. Automatic retries have finished.';
    await this.db.query(`UPDATE hr_outreach SET status=$4,reason=$5,message_id=coalesce($6,message_id),thread_id=coalesce($7,thread_id),
      sent_at=CASE WHEN $4='sent' THEN coalesce(sent_at,now()) ELSE sent_at END,cost_usd=cost_usd+$8,
      lease=NULL,lease_until=NULL,available_at=now()+interval '30 minutes',updated_at=now()
      WHERE id=$1 AND user_id=$2 AND lease=$3`, [job.id,job.user_id,job.lease,status,reason,receipt?.messageId??null,receipt?.threadId??null,extraCost]);
  }
  async defer(job: HrJob): Promise<void> {
    await this.db.query(`UPDATE hr_outreach SET status=CASE WHEN status='unconfirmed' THEN 'unconfirmed' ELSE 'queued' END,attempts=greatest(0,attempts-1),available_at=now()+interval '5 minutes',lease=NULL,lease_until=NULL WHERE id=$1 AND user_id=$2 AND lease=$3`, [job.id,job.user_id,job.lease]);
  }
}
